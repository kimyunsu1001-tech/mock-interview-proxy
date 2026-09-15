/**
 * 모의면접 AI — 무자본(무료) 체험용 프록시.
 *
 * Cloudflare Workers AI의 매일 초기화되는 무료 할당량(카드 등록 불필요)을
 * 사용해 방문자에게 API 키 없이 무료 체험을 제공한다. 소유자의 결제수단이
 * 전혀 필요 없고, 아래 두 겹의 한도 안에서만 동작하므로 비용이 발생할
 * 여지가 없다:
 *   1) 방문자(IP)별 하루 DAILY_FREE_LIMIT 메시지
 *   2) 전체 방문자 합산 하루 GLOBAL_DAILY_CAP 요청
 *      (Cloudflare Workers AI 무료 일일 예산보다 넉넉히 낮게 설정)
 */

function corsHeaders(origin, allowedOrigin) {
  const allowOrigin = origin === allowedOrigin ? origin : allowedOrigin;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    Vary: "Origin",
  };
}

function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function rateLimitedResponse(message, headers, extra) {
  return jsonResponse(
    { error: { type: "rate_limit_exceeded", message }, ...extra },
    429,
    headers
  );
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: { message: "Method not allowed" } }, 405, cors);
    }
    if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN) {
      return jsonResponse({ error: { message: "Origin not allowed" } }, 403, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: { message: "Invalid JSON body" } }, 400, cors);
    }

    const { system, messages } = body || {};
    if (!Array.isArray(messages)) {
      return jsonResponse({ error: { message: "messages required" } }, 400, cors);
    }

    const today = new Date().toISOString().slice(0, 10);

    // ---- 1) 전체 방문자 합산 하루 한도 (무료 예산 보호) ----
    const globalCap = parseInt(env.GLOBAL_DAILY_CAP || "400", 10);
    const globalKey = `global:${today}`;
    const globalCurrent = parseInt((await env.RATE_LIMIT.get(globalKey)) || "0", 10);
    if (globalCurrent >= globalCap) {
      return rateLimitedResponse(
        "오늘 무료 체험 전체 할당량이 모두 소진되었습니다. 내일 다시 이용하시거나 본인 API 키를 입력해 주세요.",
        cors
      );
    }

    // ---- 2) 방문자(IP)별 하루 한도 ----
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const limit = parseInt(env.DAILY_FREE_LIMIT || "14", 10);
    const ipKey = `ip:${ip}:${today}`;
    const ipCurrent = parseInt((await env.RATE_LIMIT.get(ipKey)) || "0", 10);
    if (ipCurrent >= limit) {
      return rateLimitedResponse(
        "오늘의 무료 체험 횟수를 모두 사용했습니다. 본인 API 키를 입력하면 계속 이용할 수 있습니다.",
        cors,
        { remaining: 0, limit }
      );
    }

    // ---- Cloudflare Workers AI 호출 (무료, 카드 불필요) ----
    // 소형 모델은 대화가 길어질수록 시스템 프롬프트의 세부 규칙(특히
    // "매 턴 꼬리질문 포함")을 놓치는 경향이 있어, 매 요청마다 마지막
    // 사용자 메시지 끝에 짧은 리마인더를 덧붙여 최신성(recency)을 이용해
    // 규칙 준수를 강화한다. 클라이언트가 저장하는 대화 기록에는 영향을
    // 주지 않는다 (여기서만 임시로 덧붙임).
    const REMINDER =
      "\n\n[진행 지침 리마인더: 반드시 위 시스템 지침의 진행 방식을 따르세요. " +
      "한 번에 질문은 하나만 하고, 방금 답변에 대한 꼬리질문을 최소 1개 포함해 " +
      "자연스럽게 이어가세요. 아직 면접 종료를 안내하지 않았다면 총평이나 점수를 " +
      "절대 언급하지 마세요.]";

    const model = env.FREE_MODEL || "@cf/meta/llama-3.1-8b-instruct";
    const aiMessages = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...messages.map((m, i) => {
        const isLast = i === messages.length - 1;
        const content = isLast && m.role === "user" ? `${m.content}${REMINDER}` : m.content;
        return { role: m.role, content };
      }),
    ];

    let aiResult;
    try {
      aiResult = await env.AI.run(model, { messages: aiMessages, max_tokens: 1024 });
    } catch (e) {
      console.error("Workers AI error:", e && e.message);
      return jsonResponse(
        {
          error: {
            type: "free_tier_unavailable",
            message: "무료 체험 서버가 일시적으로 응답하지 않습니다. 본인 API 키로 계속 이용해 주세요.",
          },
        },
        502,
        cors
      );
    }

    const text = aiResult && (aiResult.response || aiResult.result?.response);
    if (!text) {
      return jsonResponse(
        {
          error: {
            type: "free_tier_unavailable",
            message: "무료 체험 응답 생성에 실패했습니다. 본인 API 키로 계속 이용해 주세요.",
          },
        },
        502,
        cors
      );
    }

    const nextIp = ipCurrent + 1;
    const nextGlobal = globalCurrent + 1;
    await env.RATE_LIMIT.put(ipKey, String(nextIp), { expirationTtl: 172800 });
    await env.RATE_LIMIT.put(globalKey, String(nextGlobal), { expirationTtl: 172800 });

    // Anthropic Messages API와 동일한 형태로 응답해 프론트엔드 파싱 로직을 공유한다.
    return jsonResponse(
      {
        content: [{ type: "text", text }],
        remaining: Math.max(limit - nextIp, 0),
        limit,
      },
      200,
      cors
    );
  },
};
