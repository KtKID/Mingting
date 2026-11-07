export class AppError extends Error {
  /** 创建携带 HTTP 状态码的业务错误，供传输层统一返回。 */
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
