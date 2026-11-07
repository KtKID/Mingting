import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { LIMITS } from "../../shared/protocol.js";
import { AppError } from "../tasks/service.js";

/** 为一个平台实例校验本机请求、管理并发名额并设置安全头。 */
export function localHttpGuard(): RequestHandler {
  let inflight = 0;
  return (req, res, next) => {
    // 限制本机来源与并发数，并给响应设置浏览器安全头。
    const address = req.socket.remoteAddress;
    const localPort = req.socket.localPort;
    const hosts = [`127.0.0.1:${localPort}`, `localhost:${localPort}`];
    const host = req.headers.host;
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "") ||
      !host ||
      !hosts.includes(host)
    )
      return res.status(403).json({ error: "仅允许可信本机 Host" });
    if (
      req.headers.origin !== undefined &&
      req.headers.origin !== `http://${host}`
    )
      return res.status(403).json({ error: "请求 Origin 无效" });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return res.status(403).json({ error: "拒绝跨站请求" });
    if (inflight >= LIMITS.httpConcurrent)
      return res.status(429).json({ error: "请求过多" });
    inflight++;
    let released = false;
    /** 在请求完成或连接关闭时只归还一次并发名额。 */
    const release = () => {
      if (!released) {
        released = true;
        inflight--;
      }
    };
    res.once("finish", release);
    res.once("close", release);
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    next();
  };
}

/** 将业务错误、输入校验和请求体限制转换为 HTTP 响应。 */
export const httpErrorHandler: ErrorRequestHandler = (
  err: unknown,
  _req,
  res,
  _next,
) => {
  // 统一映射业务、输入校验、请求体超限和内部错误。
  if (res.headersSent) return;
  const status =
    err instanceof AppError
      ? err.status
      : err instanceof ZodError
        ? 400
        : (err as { status?: number })?.status === 413
          ? 413
          : 500;
  res.status(status).json({
    error:
      err instanceof AppError
        ? err.message
        : status === 400
          ? "输入格式不正确"
          : status === 413
            ? "请求内容过大"
            : "服务错误",
  });
};
