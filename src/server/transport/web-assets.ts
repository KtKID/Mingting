import express from "express";
import { resolve } from "node:path";
import { readApprovalHistory } from "../storage/approval-history.js";

/** 提供网页静态资源和审批回归报告归档。 */
export function webAssetsRouter() {
  const router = express.Router();
  router.get(
    "/approval-tests/data/history.json",
    /* 读取并返回审批回归归档的历史清单。 */ async (_req, res) =>
      res.json(await readApprovalHistory(resolve("reports/approval-e2e"))),
  );
  router.use(
    "/approval-tests/data",
    express.static(resolve("reports/approval-e2e"), {
      index: "index.html",
      dotfiles: "deny",
      fallthrough: false,
    }),
  );
  router.use(
    express.static(resolve("dist/web"), {
      index: "index.html",
      dotfiles: "deny",
    }),
  );
  return router;
}
