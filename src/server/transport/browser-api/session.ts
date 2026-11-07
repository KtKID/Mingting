import { randomBytes } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { LIMITS } from "../../../shared/protocol.js";

/** 为一个平台实例保存网页会话，并提供会话与 CSRF 校验。 */
export function browserSession(workspace: string, mode: "fake" | "codex") {
  const sessions = new Map<
    string,
    { csrf: string; expires: number; host: string }
  >();

  const readSession = (req: Request) => {
    const id = req.headers.cookie
      ?.split(";")
      .map(/* 去除每段 Cookie 前后的空白。 */ (c) => c.trim())
      .find(
        /* 定位网页任务会话的 Cookie。 */ (c) => c.startsWith("task_session="),
      )
      ?.slice(13);
    return id ? sessions.get(id) : undefined;
  };

  const bootstrap: RequestHandler = (req, res) => {
    // 清理过期会话并为网页初始化或续用会话与 CSRF 凭据。
    for (const [key, value] of sessions)
      if (value.expires < Date.now()) sessions.delete(key);
    const old = readSession(req);
    if (old && old.host === req.headers.host)
      return res.json({
        csrf: old.csrf,
        mode,
        workspace,
      });
    if (sessions.size >= LIMITS.sessions)
      return res.status(429).json({ error: "本机会话过多，请稍后重试" });
    const sessionId = randomBytes(32).toString("hex");
    const csrf = randomBytes(32).toString("hex");
    sessions.set(sessionId, {
      csrf,
      expires: Date.now() + LIMITS.sessionMs,
      host: req.headers.host ?? "",
    });
    res.setHeader(
      "Set-Cookie",
      `task_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${LIMITS.sessionMs / 1000}`,
    );
    res.json({
      csrf,
      mode,
      workspace,
    });
  };

  const requireSession: RequestHandler = (req, res, next) => {
    // 校验网页会话及写请求的 CSRF 凭据，再转入 API 路由。
    const s = readSession(req);
    if (!s || s.expires < Date.now() || s.host !== req.headers.host)
      return res.status(403).json({ error: "请刷新页面以建立本机会话" });
    if (
      req.method !== "GET" &&
      (req.headers.origin !== `http://${req.headers.host}` ||
        req.headers["x-csrf-token"] !== s.csrf)
    )
      return res.status(403).json({ error: "需要同源网页审批会话" });
    next();
  };

  return {
    bootstrap,
    requireSession,
    isActive: (req: Request) => (readSession(req)?.expires ?? 0) >= Date.now(),
  };
}
