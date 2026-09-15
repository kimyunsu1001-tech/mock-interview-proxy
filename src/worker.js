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

// 제시문면접 모드에서 소형 모델이 3~5문장짜리 제시문을 직접 창작하도록
// 시키면 실패하는 경우가 많아(실측 확인됨), 서버가 미리 준비한 오리지널
// 제시문(특정 대학 기출을 옮긴 것이 아닌 창작 예시) 중 하나를 결정적으로
// 내려보낸다. 상위권 대학 구술고사처럼 하나의 개념을 상반된 두 시각으로
// 제시하는 형식을 따른다.
const PASSAGE_MARKER = "다음 제시문을 읽고 답변해 주세요.";
const PRESENTATION_PASSAGES = [
  "어떤 사회에서는 개인의 자유를 최우선 가치로 여겨, 타인에게 직접적인 해를 끼치지 않는 한 개인의 선택에 공동체가 간섭해서는 안 된다고 본다. 반면 다른 사회에서는 개인이 공동체 안에서만 의미를 가지며, 공동체 전체의 이익을 위해서는 개인의 자유가 일정 부분 제한될 수 있다고 본다. 두 입장은 '자유'라는 같은 단어를 쓰지만 그 의미와 한계를 서로 다르게 규정하고 있다.",
  "최근 여러 분야에서 인공지능이 사람을 대신해 판단을 내리는 사례가 늘고 있다. 어떤 이들은 인공지능이 감정이나 편견 없이 데이터를 기반으로 판단하므로 오히려 더 공정할 수 있다고 주장한다. 반면 다른 이들은 판단의 결과에 책임질 수 없는 존재에게 중요한 결정을 맡기는 것 자체가 위험하며, 데이터 역시 인간이 만든 것이기에 편견에서 자유롭지 않다고 반박한다.",
  "한정된 자원을 배분할 때, 한쪽에서는 가장 큰 성과를 낼 수 있는 곳에 자원을 집중해야 전체의 효용이 커진다고 주장한다. 다른 쪽에서는 이미 자원이 부족한 곳을 먼저 배려하지 않으면 격차가 점점 벌어져 장기적으로 공동체 전체가 불안정해진다고 반박한다. 이 두 입장은 '무엇을 위한 배분인가'라는 질문에 서로 다르게 답하고 있다.",
];

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

    const exchangeCount = Math.floor(messages.length / 2); // 지원자 답변 수(대략)

    // ---- 제시문면접: 제시문 창작도 소형 모델에게 맡기지 않고 서버가 낸다 ----
    const isPresentationStyle = system && system.includes("제시문 준비");
    const passageAlreadyShown = messages.some(
      (m) => m.role === "assistant" && m.content.includes(PASSAGE_MARKER)
    );

    if (isPresentationStyle && exchangeCount === 1 && !passageAlreadyShown) {
      const passage =
        PRESENTATION_PASSAGES[Math.floor(Math.random() * PRESENTATION_PASSAGES.length)];
      const nextIp = ipCurrent + 1;
      const nextGlobal = globalCurrent + 1;
      await env.RATE_LIMIT.put(ipKey, String(nextIp), { expirationTtl: 172800 });
      await env.RATE_LIMIT.put(globalKey, String(nextGlobal), { expirationTtl: 172800 });
      return jsonResponse(
        {
          content: [
            {
              type: "text",
              text: `네, 답변 잘 들었습니다.\n\n${PASSAGE_MARKER}\n\n${passage}\n\n이 제시문에서 다루는 핵심 쟁점은 무엇이라고 생각하십니까?`,
            },
          ],
          remaining: Math.max(limit - nextIp, 0),
          limit,
        },
        200,
        cors
      );
    }

    // ---- 면접 마무리는 소형 모델에게만 맡기지 않고 서버가 결정적으로 제어한다 ----
    // 프롬프트 리마인더만으로는 소형 모델이 "10~14턴 후 마무리" 규칙을 계속
    // 놓치고 질문을 무한히 이어가는 경우가 실측 확인되어, 턴 수를 직접 세어
    // 임계값을 넘으면 AI 호출 없이 마무리 질문을 강제로 내려보낸다(비용도 절약).
    const CLOSING_QUESTION = "마지막으로 하고 싶은 말씀이 있으면 해주세요.";
    const lastAssistantMsg = [...messages].reverse().find((m) => m.role === "assistant");
    const closingAlreadyAsked =
      lastAssistantMsg && lastAssistantMsg.content.includes(CLOSING_QUESTION);

    if (exchangeCount >= 7 && !closingAlreadyAsked) {
      const nextIp = ipCurrent + 1;
      const nextGlobal = globalCurrent + 1;
      await env.RATE_LIMIT.put(ipKey, String(nextIp), { expirationTtl: 172800 });
      await env.RATE_LIMIT.put(globalKey, String(nextGlobal), { expirationTtl: 172800 });
      return jsonResponse(
        {
          content: [{ type: "text", text: `네, 답변 잘 들었습니다.\n\n${CLOSING_QUESTION}` }],
          remaining: Math.max(limit - nextIp, 0),
          limit,
        },
        200,
        cors
      );
    }

    // 마무리 질문 다음 턴은 "질문하지 말고 평가만 하라"는 지시가 일반
    // 꼬리질문 리마인더(질문을 반드시 하라는 규칙 포함)와 섞이면 소형
    // 모델이 지침 충돌로 다시 질문을 만들어내는 경우가 실측 확인되어,
    // 이 경우엔 리마인더 자체를 평가 전용으로 완전히 교체한다.
    const REMINDER = closingAlreadyAsked
      ? "\n\n[진행 지침 리마인더 — 반드시 지키세요:\n" +
        "지원자가 방금 '마지막으로 하고 싶은 말씀'에 답했습니다. 면접은 이미 끝났습니다.\n" +
        "1. 절대 새 질문을 하지 마세요. 꼬리질문도 하지 마세요.\n" +
        "2. 오직 아래 형식의 면접 평가만 작성하세요:\n" +
        "   - 전체 총평 (3~4문장)\n" +
        "   - 잘한 점 2~3가지 (실제 답변을 인용하며 설명)\n" +
        "   - 보완이 필요한 점 2~3가지 (실제 답변을 인용하며 설명)\n" +
        "   - 항목별 점수 (5점 만점): 지원동기 적합성 / 지원분야 이해도 / " +
        "경험의 구체성 / 태도 및 전달력\n" +
        "   - 다음 연습 때 시도해볼 것 1~2가지]"
      : "\n\n[진행 지침 리마인더 — 반드시 지키세요:\n" +
        "1. 당신은 오직 '면접관' 역할입니다. 지원자의 대사나 생각을 대신 쓰거나, " +
        "지원자의 답변 내용을 1인칭으로 이어서 서술하지 마세요.\n" +
        "2. 이번 응답은 다음 두 가지로만 구성하세요: " +
        "(1) 한 문장 이내의 짧은 인정 표현(예: '네, 답변 잘 들었습니다.') " +
        "(2) 그 답변에 대한 꼬리질문 한 개.\n" +
        "3. 지원자가 한 말을 요약·재구성·인용하지 말고, 질문만 하세요.\n" +
        "4. 아직 면접 종료를 안내하지 않았다면 총평이나 점수는 절대 언급하지 마세요.]";

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
      // temperature 실측: 0.9는 긴 응답(평가)에서 의미 없는 문자열이 섞이는
      // 붕괴 현상 발생, 0.7은 드물게 외국어 문자 한둘이 섞이는 미세한 흠,
      // 0.5는 완전히 깨끗함. 0.6을 안전 마진을 둔 상한으로 채택.
      aiResult = await env.AI.run(model, { messages: aiMessages, max_tokens: 1024, temperature: 0.6 });
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
