export class ApiError extends Error {
  constructor(status, message, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, '请求格式无效')
  return value
}

export function string(value, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw new ApiError(400, '文本为空或超过长度限制')
  }
  return value
}

export function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ApiError(400, '版本号无效')
  return value
}
