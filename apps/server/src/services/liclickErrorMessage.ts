function rawMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}
export function getLiclickUserErrorMessage(
  error: unknown,
  fallback = '莉刻生成服务暂时无法完成请求，请稍后重试。',
) {
  const message = rawMessage(error).replace(/\s+/g, ' ').trim();
  const normalized = message.toLowerCase();

  if (/用户已终止|cancelled|canceled|aborted/.test(normalized)) return '用户已终止生成任务。';
  if (
    /atlas token cache is missing|atlas.*凭证.*过期|atlas.*token.*expired|atlas.*access_token/.test(
      normalized,
    )
  ) {
    return '共享生图服务凭证未配置或已过期，请联系管理员。';
  }
  if (/billing[_\s-]*(hard[_\s-]*)?limit|计费.*上限|账单.*限额|额度.*用完/.test(normalized)) {
    return '当前账号的生图额度已用完，请检查莉刻账户额度后重试。';
  }
  if (
    /413|payload too large|request body is too large|文件过大|图片过大|参考图.*过大/.test(
      normalized,
    )
  ) {
    return '参考图超过生成服务限制，自动处理后仍未能上传，请裁剪图片或降低分辨率后重试。';
  }
  if (
    /401|403|unauthorized|forbidden|账号.*不一致|account does not match|登录.*过期|token.*expired/.test(
      normalized,
    )
  ) {
    return '登录状态已失效或账号不一致，请重新登录莉刻后重试。';
  }
  if (/429|too many requests|rate.?limit|请求.*频繁/.test(normalized)) {
    return '生成请求过于频繁，请稍等片刻后重试。';
  }
  if (/timeout|timed out|超时/.test(normalized)) return '生成服务响应超时，请稍后重试。';
  if (/network|fetch failed|无法连接|econn|enotfound|socket/.test(normalized)) {
    return '暂时无法连接生成服务，请检查网络后重试。';
  }
  if (/not found|没有找到.*任务/.test(normalized)) return '生成任务已失效，请重新生成。';
  if (/400|bad request|invalid.*parameter|invalid.*argument/.test(normalized)) {
    return '生成参数不符合服务要求，请检查提示词和参考图后重试。';
  }
  if (
    /5\d\d|internal server|bad gateway|service unavailable|assertion failed|uv_handle/.test(
      normalized,
    )
  ) {
    return '生成服务暂时异常，请稍后重试。';
  }

  const containsTechnicalDetail =
    /http\s*\d|error\b|exception|assertion|src[\\/]|\.c,? line|\{.*\}|\[object/.test(normalized);
  if (message && !containsTechnicalDetail && /[\u3400-\u9fff]/.test(message)) return message;
  return fallback;
}
