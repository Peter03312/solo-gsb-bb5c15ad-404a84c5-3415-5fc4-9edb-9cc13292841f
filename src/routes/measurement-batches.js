'use strict';

/*
 * 分段实测 CSV 导入批次路由（规则 18）。
 *
 * 计划级（挂载于 /api/plans/:id/measurement-batches，mergeParams）：
 *   POST /preview   保管员：CSV 预演——逐行按自然年剂量 + 整批预计占用，不写库、不改额度
 *   POST /          保管员：导入为待确认批次（任一行错误整批不保存，400 列出行号与原因）
 *   GET  /          登录：该计划的批次列表
 * 批次级（挂载于 /api/measurement-batches）：
 *   GET    /:id         登录：批次详情（含逐行按年剂量与确认后回联的实测编号）
 *   POST   /:id/confirm 保管员：确认批次——展品锁事务内重新校验批次与实时占用，
 *                       全部有效才原子生成已确认实测并记录批次审计；校验失败保持待确认
 *                       且不计量（409 列出行号与原因）；重复确认返回原批次结果；
 *                       确认导致超限仍入账（409 列出超额年份并按既有规则转待复核）
 *   DELETE /:id         保管员：删除待确认批次（已确认批次不可删，其生成的实测保留）
 */

const express = require('express');
const { query, withExhibitTransaction } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { recordAudit } = require('../audit');
const { ValidationError, ConflictError } = require('../validation');
const {
  ACTIVE_PLAN_STATUSES,
  lockExhibit,
  getPlan,
  computeOccupancy,
} = require('../service');
const {
  parseMeasurementCsv,
  validateMeasurementBatchRows,
  previewMeasurementBatch,
  serializeBatch,
} = require('../measurement-batch');
const { doseByYear, yearMapToObject, addYearDose, tsToWallString } = require('../dosing');
const { exhibitDetail } = require('./exhibits');
// 复用单条实测确认的超限判定与转待复核逻辑（同一口径）
const {
  overflowInfoFromOccupancy,
  flagPlansForOverflow,
} = require('./measurements');

/** 行号 + 原因的错误（400，details.rowErrors 列出全部）。 */
function csvRowError(prefix, rowErrors) {
  const shown = rowErrors.slice(0, 5).map((e) => `第 ${e.row} 行：${e.reason}`).join('；');
  const more = rowErrors.length > 5 ? `；等共 ${rowErrors.length} 处错误` : '';
  const err = new ValidationError(`${prefix}：${shown}${more}，整批未保存`);
  err.details = { rowErrors };
  return err;
}

/** 确认前复核失败（409，批次保持待确认）。 */
function confirmRowError(batchId, rowErrors) {
  const shown = rowErrors.slice(0, 5).map((e) => `第 ${e.row} 行：${e.reason}`).join('；');
  const more = rowErrors.length > 5 ? `；等共 ${rowErrors.length} 处错误` : '';
  return new ConflictError(
    `批次 #${batchId} 确认前复核未通过：${shown}${more}；批次保持待确认，未计量`,
    { batchId, rowErrors }
  );
}

function parsePlanId(req) {
  const planId = Number(req.params.id);
  if (!Number.isInteger(planId) || planId <= 0) throw new ValidationError('计划 ID 无效');
  return planId;
}

function parseBatchId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('批次 ID 无效');
  return id;
}

function assertPlanImportable(plan) {
  if (!ACTIVE_PLAN_STATUSES.includes(plan.status)) {
    throw new ValidationError('只有已批准（或待复核）计划才能导入实测批次');
  }
}

async function getBatchRowList(client, batchId) {
  const { rows } = await client.query(
    'SELECT * FROM measurement_batch_rows WHERE batch_id = $1 ORDER BY row_no',
    [batchId]
  );
  return rows;
}

/** JSONB 字段兼容：真实 pg 返回对象，个别驱动可能返回字符串。 */
function normalizeJson(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// 计划级路由：/api/plans/:id/measurement-batches
// ---------------------------------------------------------------------------

const planRouter = express.Router({ mergeParams: true });
planRouter.use(requireAuth);

/**
 * CSV 预演（不写库、不改变额度）：
 * 逐行返回按自然年剂量，整批返回按确认后口径的预计占用（上限/当前占用/本批剂量/
 * 预计占用/剩余/超额）。任一行非法：400 + details.rowErrors（行号与原因）。
 */
planRouter.post('/preview', requireRole('conservator'), async (req, res, next) => {
  try {
    const planId = parsePlanId(req);
    const { rows, errors: parseErrors } = parseMeasurementCsv(req.body && req.body.csv);
    const plan = await getPlan({ query }, planId);
    assertPlanImportable(plan);
    // 解析错误与窗口/相交校验错误合并，一次性列出全部行号与原因
    const rowErrors = await validateMeasurementBatchRows({ query }, plan, rows);
    const allErrors = [...parseErrors, ...rowErrors].sort((a, b) => a.row - b.row);
    if (allErrors.length > 0) throw csvRowError('CSV 校验未通过', allErrors);

    const preview = await previewMeasurementBatch({ query }, plan, rows);
    res.json({
      preview: {
        planId: Number(plan.id),
        exhibitId: Number(plan.exhibit_id),
        rowCount: rows.length,
        ...preview,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 导入为待确认批次：与预演同一套校验，全部通过在展品锁事务内原子保存批次与逐行；
 * 待确认批次不计量（不改变任何额度占用）。任一行错误：400 + details.rowErrors，整批不保存。
 * 成功响应附与预演同构的 preview（逐行按年剂量 + 整批预计占用）。
 */
planRouter.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const planId = parsePlanId(req);
    const { rows, errors: parseErrors } = parseMeasurementCsv(req.body && req.body.csv);
    const sourceName = req.body && typeof req.body.sourceName === 'string'
      && req.body.sourceName.trim() !== ''
      ? req.body.sourceName.trim().slice(0, 200)
      : null;

    const prePlan = await getPlan({ query }, planId);
    const out = await withExhibitTransaction(prePlan.exhibit_id, async (client) => {
      await lockExhibit(client, prePlan.exhibit_id);
      const plan = await getPlan(client, planId);
      assertPlanImportable(plan);
      // 解析错误与窗口/相交校验错误合并，一次性列出全部行号与原因，整批不保存
      const rowErrors = await validateMeasurementBatchRows(client, plan, rows);
      const allErrors = [...parseErrors, ...rowErrors].sort((a, b) => a.row - b.row);
      if (allErrors.length > 0) throw csvRowError('CSV 校验未通过', allErrors);

      const inserted = await client.query(
        `INSERT INTO measurement_batches (plan_id, exhibit_id, status, row_count, source_name, created_by)
         VALUES ($1, $2, 'pending', $3, $4, $5) RETURNING *`,
        [planId, plan.exhibit_id, rows.length, sourceName, req.sessionUser.userId]
      );
      const batch = inserted.rows[0];
      const rowRows = [];
      for (const r of rows) {
        const ins = await client.query(
          `INSERT INTO measurement_batch_rows (batch_id, row_no, start_ts, end_ts, actual_lux)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [batch.id, r.row, new Date(r.startMs), new Date(r.endMs), r.lux]
        );
        rowRows.push(ins.rows[0]);
      }

      const preview = await previewMeasurementBatch(client, plan, rows);
      await recordAudit(client, req.sessionUser, 'measurement_batch.import',
        'measurement_batch', batch.id, {
          planId: Number(plan.id),
          exhibitId: Number(plan.exhibit_id),
          rowCount: rows.length,
          sourceName,
          batchYearly: preview.batchYearly,
        });
      return { batch: serializeBatch(batch, rowRows), preview };
    });

    res.status(201).json({
      batch: out.batch,
      preview: {
        planId: Number(prePlan.id),
        exhibitId: Number(prePlan.exhibit_id),
        rowCount: rows.length,
        ...out.preview,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** 该计划的批次列表（登录可读；不含逐行明细）。 */
planRouter.get('/', async (req, res, next) => {
  try {
    const planId = parsePlanId(req);
    await getPlan({ query }, planId); // 不存在 -> 400
    const { rows } = await query(
      'SELECT * FROM measurement_batches WHERE plan_id = $1 ORDER BY id DESC',
      [planId]
    );
    res.json({ batches: rows.map((b) => serializeBatch(b)) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 批次级路由：/api/measurement-batches
// ---------------------------------------------------------------------------

const router = express.Router();
router.use(requireAuth);

/** 批次详情（含逐行按年剂量；确认后各行附 measurementId）。 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseBatchId(req);
    const { rows } = await query('SELECT * FROM measurement_batches WHERE id = $1', [id]);
    if (rows.length === 0) throw new ValidationError('实测批次不存在');
    const rowRows = await getBatchRowList({ query }, id);
    res.json({ batch: serializeBatch(rows[0], rowRows) });
  } catch (err) {
    next(err);
  }
});

/**
 * 确认批次：
 *  - 展品锁事务内重新校验：计划仍为已批准/待复核；每行仍完整落在计划开灯窗内；
 *    不与同展品未作废实测（含草稿）、停灯、照明事故、其他待确认批次行相交；行间互不相交。
 *  - 全部有效才原子生成已确认实测（measurements，batch_id/batch_row_no 回联）并记录批次审计；
 *    任一失败保持待确认且不计量（409，details.rowErrors）。
 *  - 确认导致超限仍入账：返回 409 列出超额年份，并按既有规则把相关年度尚未开始且
 *    有估算残余的已批准计划转待复核。
 *  - 重复确认返回原批次结果（confirm_result 快照），不重复生成实测、不重复转复核。
 */
router.post('/:id/confirm', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = parseBatchId(req);
    const pre = await query('SELECT exhibit_id FROM measurement_batches WHERE id = $1', [id]);
    if (pre.rows.length === 0) throw new ValidationError('实测批次不存在');
    const exhibitId = pre.rows[0].exhibit_id;

    const result = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);
      const bRes = await client.query(
        'SELECT * FROM measurement_batches WHERE id = $1 FOR UPDATE',
        [id]
      );
      const batch = bRes.rows[0];
      if (!batch) throw new ValidationError('实测批次不存在');
      const rowRows = await getBatchRowList(client, id);

      // 重复确认：原样返回首次确认的结果快照（幂等，不再改动任何数据）
      if (batch.status === 'confirmed') {
        return {
          alreadyConfirmed: true,
          batch: serializeBatch(batch, rowRows),
          result: normalizeJson(batch.confirm_result),
        };
      }

      const plan = await getPlan(client, batch.plan_id);
      if (!ACTIVE_PLAN_STATUSES.includes(plan.status)) {
        throw new ConflictError(
          `批次 #${id} 确认前复核未通过：计划 #${plan.id} 当前状态为 ${plan.status}，` +
          '不再是已批准/待复核；批次保持待确认，未计量',
          { batchId: id, rowErrors: [] }
        );
      }

      // 实时重核每一行（排除本批次自身行）
      const rows = rowRows.map((r) => ({
        row: Number(r.row_no),
        startMs: new Date(r.start_ts).getTime(),
        endMs: new Date(r.end_ts).getTime(),
        lux: Number(r.actual_lux),
      }));
      const rowErrors = await validateMeasurementBatchRows(client, plan, rows, {
        excludeBatchId: id,
      });
      if (rowErrors.length > 0) throw confirmRowError(id, rowErrors);

      // 全部有效：原子生成已确认实测并回联批次行
      const measurements = [];
      for (const r of rowRows) {
        const startMs = new Date(r.start_ts).getTime();
        const endMs = new Date(r.end_ts).getTime();
        const lux = Number(r.actual_lux);
        const ins = await client.query(
          `INSERT INTO measurements
             (plan_id, exhibit_id, start_ts, end_ts, actual_lux, note, status,
              created_by, confirmed_by, confirmed_at, batch_id, batch_row_no)
           VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, $7, now(), $8, $9)
           RETURNING *`,
          [
            plan.id, plan.exhibit_id, new Date(startMs), new Date(endMs), lux,
            `批次 #${id} 第 ${Number(r.row_no)} 行`,
            req.sessionUser.userId, id, Number(r.row_no),
          ]
        );
        const m = ins.rows[0];
        await client.query(
          'UPDATE measurement_batch_rows SET measurement_id = $1 WHERE id = $2',
          [m.id, r.id]
        );
        measurements.push({
          id: Number(m.id),
          row: Number(r.row_no),
          start: tsToWallString(startMs),
          end: tsToWallString(endMs),
          actualLux: lux,
          yearly: yearMapToObject(doseByYear([{ start: startMs, end: endMs }], lux)),
        });
      }

      // 实时占用（已含本次生成的已确认实测）；超额年份以本批剂量实际影响的年份为限
      const occupancy = await computeOccupancy(client, plan.exhibit_id);
      const batchYearly = {};
      for (const m of measurements) addYearDose(batchYearly, m.yearly);
      const { overflows, overflowYears } = overflowInfoFromOccupancy(
        occupancy,
        Object.keys(batchYearly).map(Number)
      );

      // 确认导致超限仍入账：按既有规则转待复核（尚未开始且有估算残余的已批准计划）
      let flagged = [];
      if (overflowYears.length > 0) {
        flagged = await flagPlansForOverflow(client, req.sessionUser, {
          exhibitId: plan.exhibit_id,
          occupancy,
          overflowYears,
          trigger: { triggerBatchId: id },
          reason: () =>
            `实测批次 #${id} 确认后导致 ${overflowYears.join('、')} 年额度超限，转待复核`,
        });
      }

      const confirmResult = {
        batchId: id,
        planId: Number(plan.id),
        exhibitId: Number(plan.exhibit_id),
        rowCount: measurements.length,
        batchYearly,
        measurements,
        overflows,
        flaggedPlans: flagged,
        confirmedBy: req.sessionUser.userId,
        confirmedAt: new Date().toISOString(),
      };
      await client.query(
        `UPDATE measurement_batches
            SET status = 'confirmed', confirmed_by = $1, confirmed_at = now(),
                confirm_result = $2::jsonb
          WHERE id = $3`,
        [req.sessionUser.userId, JSON.stringify(confirmResult), id]
      );
      await recordAudit(client, req.sessionUser, 'measurement_batch.confirm',
        'measurement_batch', id, {
          planId: Number(plan.id),
          exhibitId: Number(plan.exhibit_id),
          rowCount: measurements.length,
          measurementIds: measurements.map((m) => m.id),
          batchYearly,
          overflows,
        });

      const refreshed = (await client.query(
        'SELECT * FROM measurement_batches WHERE id = $1', [id]
      )).rows[0];
      const refreshedRows = await getBatchRowList(client, id);
      const detail = await exhibitDetail(client, plan.exhibit_id, { lock: true });
      return {
        alreadyConfirmed: false,
        batch: serializeBatch(refreshed, refreshedRows),
        result: confirmResult,
        overflows,
        flagged,
        detail,
      };
    });

    if (!result.alreadyConfirmed && result.overflows.length > 0) {
      // 批次已确认并入账，但触发超限：用 409 明确报告年份、超额量及被转待复核的计划
      return res.status(409).json({
        message:
          `实测批次 #${id} 已确认并入账，但确认后超限：` +
          result.overflows.map((o) => `${o.year} 年超出 ${o.excess} lx·h`).join('；') +
          (result.flagged.length
            ? `。已将 ${result.flagged.length} 条尚未开始的计划转为待复核`
            : '；该年度没有尚未开始的已批准计划'),
        overflows: result.overflows,
        flaggedPlans: result.flagged,
        batch: result.batch,
        result: result.result,
        detail: result.detail,
      });
    }
    res.json({
      ...(result.alreadyConfirmed ? { alreadyConfirmed: true } : {}),
      batch: result.batch,
      result: result.result,
      ...(result.detail ? { detail: result.detail } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/** 删除待确认批次（已确认批次不可删：其生成的已确认实测须保留）。 */
router.delete('/:id', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = parseBatchId(req);
    const pre = await query('SELECT exhibit_id FROM measurement_batches WHERE id = $1', [id]);
    if (pre.rows.length === 0) throw new ValidationError('实测批次不存在');
    await withExhibitTransaction(pre.rows[0].exhibit_id, async (client) => {
      await lockExhibit(client, pre.rows[0].exhibit_id);
      const bRes = await client.query(
        'SELECT * FROM measurement_batches WHERE id = $1 FOR UPDATE',
        [id]
      );
      const batch = bRes.rows[0];
      if (!batch) throw new ValidationError('实测批次不存在');
      if (batch.status !== 'pending') {
        throw new ValidationError('只有待确认批次可以删除；已确认批次及其生成的实测记录须保留');
      }
      await client.query('DELETE FROM measurement_batches WHERE id = $1', [id]);
      await recordAudit(client, req.sessionUser, 'measurement_batch.delete',
        'measurement_batch', id, {
          planId: Number(batch.plan_id),
          exhibitId: Number(batch.exhibit_id),
          rowCount: Number(batch.row_count),
        });
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { planRouter, router };
