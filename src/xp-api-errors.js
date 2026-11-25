import { XpError } from './xp-errors.js';
import { XP_KO } from './xp-locale-ko.js';

const messages = Object.freeze({
  AUTH_REQUIRED: '로그인이 필요합니다.',
  AUTH_EXPIRED: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
  INVALID_LOGIN:
    '로그인 요청이 올바르지 않거나 만료되었습니다. 다시 시작해 주세요.',
  INVALID_CODE: '로그인 확인 코드가 올바르지 않거나 만료되었습니다.',
  PROVIDER_UNAVAILABLE:
    '디스코드 로그인에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  NOT_MEMBER: '오프레코드 서버에 가입한 회원만 이용할 수 있습니다.',
  FORBIDDEN: '이 작업을 실행할 권한이 없습니다.',
  INVALID_REQUEST: '요청 내용이 올바르지 않습니다.',
  NOT_FOUND: '요청한 항목을 찾을 수 없습니다.',
  METHOD_NOT_ALLOWED: '지원하지 않는 요청 방식입니다.',
  BODY_TOO_LARGE: '요청 내용이 너무 큽니다. 내용을 줄여 주세요.',
  UNSUPPORTED_MEDIA: '지원하지 않는 요청 형식입니다.',
  RATE_LIMITED: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  SERVER_BUSY:
    '요청이 많아 잠시 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  TRACKING_UNAVAILABLE:
    '서버 정보를 동기화하고 있습니다. 잠시 후 다시 시도해 주세요.',
  REQUEST_TIMEOUT:
    '요청 시간이 초과되었습니다. 처리 내역을 확인한 뒤 다시 시도해 주세요.',
  INTERNAL_ERROR: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
});

export class XpApiError extends XpError {
  constructor(code, status = 400, retryAfter = null) {
    super(code);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function xpApiError(error) {
  if (!(error instanceof XpError)) {
    return {
      status: 500,
      body: {
        error: { code: 'INTERNAL_ERROR', message: messages.INTERNAL_ERROR },
      },
    };
  }
  const code = error.code;
  const status =
    error instanceof XpApiError
      ? error.status
      : code === 'FORBIDDEN'
        ? 403
        : ['UNAVAILABLE', 'DISCORD_UNAVAILABLE'].includes(code)
          ? 503
          : /NOT_FOUND$/.test(code)
            ? 404
            : /CONFLICT|STALE|BALANCE|ALREADY|PURCHASED|OWNED|PENDING|COOLDOWN|LOCKED/.test(
                  code,
                )
              ? 409
              : 400;
  return {
    status,
    retryAfter: error.retryAfter,
    body: {
      error: {
        code,
        message:
          messages[code] ?? XP_KO.errors[code] ?? messages.INVALID_REQUEST,
      },
    },
  };
}
