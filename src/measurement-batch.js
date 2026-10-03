'use strict';

/*
 * 分段实测 CSV 导入批次（规则 18）核心逻辑：
 *  - parseMeasurementCsv：把 CSV 文本解析为数据行（每行：墙上起止日期时间 + 实际照度；
 *    行号按数据行从 1 开始，不含表头与空行）；
 *  - validateMeasurementBatchRows：逐行校验（正时长、正照度、完整落在计划开灯窗内；
 *    行间互不相交；不与同展品未作废实测（含草稿）、停灯、照明事故、其他待确认批次行相交）；
 *  - previewMeasurementBatch：逐行按自然年剂量 + 整批预计占用（按“确认后口径”预演，不写库）；
 *  - serializeBatch：批次对外字段（含逐行按年剂量与确认后回联的实测编号）。
 *
 * 待确认批次不计量：computeOccupancy 不读批次表；确认时由路由在展品锁事务内重新校验并
 * 原子生成已确认实测（measurements 表，batch_id/batch_row_no 回联），既有单条实测、
 * 年度占用与封存账册对照的字段与口径不变。
 */

const { ValidationError, isValidYmd } = require('./validation');
const {
  wallToTs,
  tsToWallString,
  doseByYear,
  yearMapToObject,
  addYearDose,
  containsInterval,
  intersects,
  round3,
} = require('./dosing');
const { planWindows, computeOccupancy } = require('./service');

/** 单批最大数据行数（防御误传超大文件）。 */
const MAX_BATCH_ROWS = 1000;

/** 首行第一列命中这些表头名（小写）时按表头跳过。 */
const HEADER_FIRST_COL = new Set([
  'start', 'starttime', 'start_time', 'start_at',
  '开始', '开始时间', '起始时间', '开始日期时间',
]);

/** 墙上日期时间：YYYY-MM-DD HH:MM 或 YYYY-MM-DDTHH:MM（可带 :SS 秒）。 */
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** 解析一个墙上日期时间为 UTC 毫秒；非法返回 null。 */
function parseWallDateTime(raw) {
  const m = DATETIME_RE.exec(String(raw).trim());
  if (!m) return null;
  const ymd = m[1];
  if (!isValidYmd(ymd)) return null;
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  const ss = m[4] ? Number(m[4]) : 0;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return wallToTs(ymd, hh * 60 + mm) + ss * 1000;
}

/**
 * 解析分段实测 CSV 文本。
 * 每行 3 列：开始时间,结束时间,实际照度（墙上时间，可跨日跨年）。
 * 支持 \r\n/\n、首尾空白、空行跳过、UTF-8 BOM、可选表头行。
 * 返回 { rows: [{ row, startMs, endMs, lux }], errors: [{ row, reason }] }；
 * 行号按数据行从 1 开始（不含表头与空行）。文本缺失/为空抛 400。
 */
function parseMeasurementCsv(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new ValidationError('CSV 内容不能为空（请求体字段 csv）');
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const rows = [];
  const errors = [];
  let dataRowNo = 0;
  let firstLineChecked = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (!firstLineChecked) {
      firstLineChecked = true;
      const firstCol = line.split(',')[0].trim().toLowerCase();
      if (HEADER_FIRST_COL.has(firstCol)) continue; // 表头行
    }
    dataRowNo += 1;
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length !== 3) {
      errors.push({
        row: dataRowNo,
        reason: `应含 3 列（开始时间,结束时间,实际照度），实际为 ${cols.length} 列`,
      });
      continue;
    }
    const startMs = parseWallDateTime(cols[0]);
    if (startMs === null) {
      errors.push({ row: dataRowNo, reason: `开始时间无效：${cols[0]}（应为 YYYY-MM-DD HH:MM）` });
      continue;
    }
    const endMs = parseWallDateTime(cols[1]);
    if (endMs === null) {
      errors.push({ row: dataRowNo, reason: `结束时间无效：${cols[1]}（应为 YYYY-MM-DD HH:MM）` });
      continue;
    }
    const lux = Number(cols[2]);
    if (cols[2] === '' || !Number.isFinite(lux)) {
      errors.push({ row: dataRowNo, reason: `实际照度必须是数字：${cols[2] === '' ? '（空）' : cols[2]}` });
      continue;
    }
    if (lux <= 0) {
      errors.push({ row: dataRowNo, reason: '实际照度必须为正数' });
      continue;
    }
    if (lux > 1000000) {
      errors.push({ row: dataRowNo, reason: '实际照度不能大于 1000000' });
      continue;
    }
    if (!(endMs > startMs)) {
      errors.push({ row: dataRowNo, reason: '结束时间必须晚于开始时间（时长须为正）' });
      continue;
    }
    rows.push({ row: dataRowNo, startMs, endMs, lux });
  }
  if (dataRowNo > MAX_BATCH_ROWS) {
    throw new ValidationError(`单次导入不能超过 ${MAX_BATCH_ROWS} 行（本次 ${dataRowNo} 行）`);
  }
  if (dataRowNo === 0) throw new ValidationError('CSV 中没有数据行');
  return { rows, errors };
}

/**
 * 逐行校验批次数据行（事务内或只读连接均可；调用方负责展品锁）。
 * rows 为 parseMeasurementCsv 的 rows（已保证正时长、正照度）。
 * excludeBatchId：确认既有批次时排除本批次自身行（其他待确认批次行仍参与相交判定）。
 * 返回 [{ row, reason }]，空数组表示全部有效。
 */
async function validateMeasurementBatchRows(client, plan, rows, { excludeBatchId = null } = {}) {
  const errors = [];
  const windows = planWindows(plan);
  const exhibitId = plan.exhibit_id;

  // 同展品现状一次取出，逐行在内存中比对（展品级数据量小）
  const measRows = (await client.query(
    `SELECT id, plan_id, start_ts, end_ts, status
       FROM measurements
      WHERE exhibit_id = $1 AND status <> 'annulled'
      ORDER BY id`,
    [exhibitId]
  )).rows;
  const blackoutRows = (await client.query(
    `SELECT id, plan_id, start_ts, end_ts
       FROM blackouts WHERE exhibit_id = $1 ORDER BY id`,
    [exhibitId]
  )).rows;
  const incidentRows = (await client.query(
    `SELECT id, start_ts, end_ts
       FROM lighting_incidents WHERE exhibit_id = $1 ORDER BY id`,
    [exhibitId]
  )).rows;
  // 其他待确认批次的行同样参与相交判定（与“待确认草稿实测互斥”同口径）
  const pendingRows = (await client.query(
    `SELECT r.batch_id, r.row_no, r.start_ts, r.end_ts
       FROM measurement_batch_rows r
       JOIN measurement_batches b ON b.id = r.batch_id
      WHERE b.exhibit_id = $1 AND b.status = 'pending'
        AND ($2::bigint IS NULL OR b.id <> $2)
      ORDER BY r.batch_id, r.row_no`,
    [exhibitId, excludeBatchId]
  )).rows;

  // 停灯原因文本附计划标题（单独批量查，规避内存驱动 JOIN 缺陷）
  const blackoutPlanIds = [...new Set(blackoutRows.map((b) => Number(b.plan_id)))];
  const titleMap = new Map();
  if (blackoutPlanIds.length > 0) {
    const placeholders = blackoutPlanIds.map((_, i) => `$${i + 1}`).join(',');
    const tRows = await client.query(
      `SELECT id, title FROM plans WHERE id IN (${placeholders})`,
      blackoutPlanIds
    );
    for (const t of tRows.rows) titleMap.set(Number(t.id), t.title);
  }

  const toMs = (v) => new Date(v).getTime();
  const wall = (ms) => tsToWallString(ms);

  for (const row of rows) {
    const reasons = [];
    const seg = { start: row.startMs, end: row.endMs };
    if (!windows.some((w) => containsInterval(w, seg))) {
      reasons.push(
        `时段 ${wall(seg.start)} ~ ${wall(seg.end)} 没有完整落在计划 #${plan.id} 的开灯窗内`
      );
    }
    // 行间相交（同批其他数据行）
    for (const other of rows) {
      if (other.row === row.row) continue;
      if (intersects(seg, { start: other.startMs, end: other.endMs })) {
        reasons.push(`与第 ${other.row} 行（${wall(other.startMs)} ~ ${wall(other.endMs)}）相交`);
        break;
      }
    }
    for (const m of measRows) {
      const ms = { start: toMs(m.start_ts), end: toMs(m.end_ts) };
      if (intersects(seg, ms)) {
        reasons.push(
          `与${m.status === 'draft' ? '待确认' : '已确认'}实测 #${m.id}（${wall(ms.start)} ~ ${wall(ms.end)}）相交`
        );
      }
    }
    for (const b of blackoutRows) {
      const bs = { start: toMs(b.start_ts), end: toMs(b.end_ts) };
      if (intersects(seg, bs)) {
        const title = titleMap.get(Number(b.plan_id));
        reasons.push(
          `与停灯记录 #${b.id}（计划${title ? `「${title}」` : ` #${b.plan_id}`}，` +
          `${wall(bs.start)} ~ ${wall(bs.end)}）相交`
        );
      }
    }
    for (const x of incidentRows) {
      const xs = { start: toMs(x.start_ts), end: toMs(x.end_ts) };
      if (intersects(seg, xs)) {
        reasons.push(`与计划外照明事故 #${x.id}（${wall(xs.start)} ~ ${wall(xs.end)}）相交`);
      }
    }
    for (const p of pendingRows) {
      const ps = { start: toMs(p.start_ts), end: toMs(p.end_ts) };
      if (intersects(seg, ps)) {
        reasons.push(
          `与待确认批次 #${p.batch_id} 第 ${p.row_no} 行（${wall(ps.start)} ~ ${wall(ps.end)}）相交`
        );
      }
    }
    if (reasons.length > 0) errors.push({ row: row.row, reason: reasons.join('；') });
  }
  return errors;
}

/**
 * 批次预演（不写库）：逐行按自然年剂量 + 整批预计占用。
 * “整批预计占用”按确认后口径预演：批次各行作为已确认实测（替代对应估算残余）并入
 * 当前占用，逐受影响年份给出 上限/当前占用/本批剂量/预计占用/剩余/超额。
 * 返回 { rows, batchYearly, occupancy, overflows }。
 */
async function previewMeasurementBatch(client, plan, rows) {
  const rowPreviews = rows.map((r) => ({
    row: r.row,
    start: tsToWallString(r.startMs),
    end: tsToWallString(r.endMs),
    actualLux: r.lux,
    yearly: yearMapToObject(doseByYear([{ start: r.startMs, end: r.endMs }], r.lux)),
  }));
  const batchYearly = {};
  for (const rp of rowPreviews) addYearDose(batchYearly, rp.yearly);

  const extras = rows.map((r) => ({
    planId: plan.id,
    start: r.startMs,
    end: r.endMs,
    lux: r.lux,
  }));
  const before = await computeOccupancy(client, plan.exhibit_id);
  const after = await computeOccupancy(client, plan.exhibit_id, { extraMeasurements: extras });

  const occupancy = {};
  const overflows = [];
  for (const yearStr of Object.keys(batchYearly)) {
    const b = before.years[yearStr];
    const a = after.years[yearStr];
    const limit = a && a.limit !== null && a.limit !== undefined ? a.limit : null;
    const usedBefore = b ? b.used : 0;
    const projected = a ? a.used : round3(batchYearly[yearStr]);
    const excess = limit !== null && projected - limit > 0.005
      ? round3(projected - limit)
      : null;
    occupancy[yearStr] = {
      year: Number(yearStr),
      limit,
      usedBefore,
      batchDose: batchYearly[yearStr],
      projected,
      remainingAfter: limit === null ? null : round3(limit - projected),
      excess,
      missingLimit: limit === null,
    };
    if (excess !== null) {
      overflows.push({ year: Number(yearStr), limit, projected, excess });
    }
  }
  return { rows: rowPreviews, batchYearly, occupancy, overflows };
}

/** 批次对外字段（含逐行按年剂量；确认后各行附 measurementId）。 */
function serializeBatch(batch, rowRows = []) {
  return {
    id: Number(batch.id),
    planId: Number(batch.plan_id),
    exhibitId: Number(batch.exhibit_id),
    status: batch.status,
    rowCount: Number(batch.row_count),
    sourceName: batch.source_name || null,
    createdBy: batch.created_by != null ? Number(batch.created_by) : null,
    createdAt: batch.created_at,
    confirmedBy: batch.confirmed_by != null ? Number(batch.confirmed_by) : null,
    confirmedAt: batch.confirmed_at || null,
    rows: rowRows.map((r) => {
      const startMs = new Date(r.start_ts).getTime();
      const endMs = new Date(r.end_ts).getTime();
      const lux = Number(r.actual_lux);
      return {
        row: Number(r.row_no),
        start: tsToWallString(startMs),
        end: tsToWallString(endMs),
        actualLux: lux,
        yearly: yearMapToObject(doseByYear([{ start: startMs, end: endMs }], lux)),
        measurementId: r.measurement_id != null ? Number(r.measurement_id) : null,
      };
    }),
  };
}

module.exports = {
  MAX_BATCH_ROWS,
  parseMeasurementCsv,
  validateMeasurementBatchRows,
  previewMeasurementBatch,
  serializeBatch,
};
