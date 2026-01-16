import { NextRequest, NextResponse } from "next/server";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const NVIDIA_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";
const MISTRAL_MODEL = "mistralai/devstral-2512:free";
const MOLMO_MODEL = "allenai/molmo-2-8b:free";
const TNG_MODEL = "tngtech/tng-r1t-chimera:free";
const GEMMA_MODEL = "google/gemma-3n-e4b-it:free";
const MIMO_MODEL = "xiaomi/mimo-v2-flash:free";

type ChatRole = "system" | "user" | "assistant" | "tool";

type ChatMessage = {
  role: ChatRole;
  // Allow arbitrary content so callers can send
  // multimodal messages (text, image_url, video_url arrays, etc.).
  content: unknown;
  reasoning_details?: unknown;
};

type ChatRequestBody = {
  messages?: ChatMessage[];
  reasoning?: unknown;
  // Optional list of model IDs that the client wants to use
  activeModels?: string[];
};

type ModelAnswer = {
  index: number;
  model: string;
  content: string;
};

type CrossEvaluation = {
  scores: Record<string, number>;
  winnerModelId: string | null;
  winnerIndex: number | null;
  judges: {
    judgeModelId: string;
    votedModelId: string | null;
    reasoning?: string;
  }[];
};

async function runCrossEvaluation(
  choices: any[],
  baseHeaders: Record<string, string>,
  userQuestion: string | null,
): Promise<CrossEvaluation | null> {
  if (!userQuestion || !Array.isArray(choices) || choices.length < 2) {
    return null;
  }

  const answers: ModelAnswer[] = choices
    .map((choice, index) => {
      const model = typeof choice?.model === "string" ? choice.model : null;
      const message = choice?.message;
      if (!model || !message) return null;

      const rawContent = message.content;
      const content =
        typeof rawContent === "string"
          ? rawContent
          : JSON.stringify(rawContent);

      return {
        index,
        model,
        content,
      } satisfies ModelAnswer;
    })
    .filter((a: ModelAnswer | null): a is ModelAnswer => a !== null && a.content.trim().length > 0);

  if (answers.length < 2) {
    return null;
  }

  const globalScores: Record<string, number> = {};
  for (const a of answers) {
    globalScores[a.model] = 0;
  }

  const judgesResults: {
    judgeModelId: string;
    votedModelId: string | null;
    reasoning?: string;
  }[] = [];

  const judgePromises = answers.map(async (judge) => {
    const candidates = answers.filter((a) => a.index !== judge.index);

    const judgeMessages = [
      {
        role: "system" as const,
        content:
          "You are strictly evaluating answers from other AI models. " +
          "First, independently solve the user's question yourself step by step. " +
          "Derive a single final answer that you believe is correct. " +
          "Then, for EACH candidate answer, check whether its final stated answer " +
          "EXACTLY matches your own final answer (including numbers, units, and key facts). " +
          "Only treat a candidate as CORRECT if it explicitly states the same final answer. " +
          "Do NOT say that all candidates are correct if even one of them disagrees with your computed answer. " +
          "From the candidates that are correct by this criterion, choose the single best based on clarity and completeness. " +
          "If none of the candidates are fully correct, choose the one that is LEAST wrong and explain why. " +
          "These answers are from other models, not from you. " +
          "Respond ONLY in strict JSON with fields: " +
          '{"winner_model_id":"<model-id>","reasoning":"<short explanation of why this candidate best matches your computed answer>"}. ' +
          "Do not include any extra text, markdown, or formatting.",
      },
      {
        role: "user" as const,
        content:
          `Question:\n${userQuestion}\n\n` +
          candidates
            .map(
              (c, idx) =>
                `Candidate ${idx + 1} (model: ${c.model}):\n${c.content}`,
            )
            .join("\n\n"),
      },
    ];

    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify({
          model: judge.model,
          messages: judgeMessages,
          temperature: 0,
        }),
      });

      if (!res.ok) {
        judgesResults.push({
          judgeModelId: judge.model,
          votedModelId: null,
        });
        return;
      }

      const json = await res.json();
      let content = json?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        judgesResults.push({
          judgeModelId: judge.model,
          votedModelId: null,
        });
        return;
      }

      let text = content.trim();
      if (text.startsWith("```")) {
        const firstBrace = text.indexOf("{");
        const lastBrace = text.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1) {
          text = text.slice(firstBrace, lastBrace + 1);
        }
      }

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        judgesResults.push({
          judgeModelId: judge.model,
          votedModelId: null,
        });
        return;
      }

      const votedModelId =
        parsed && typeof parsed.winner_model_id === "string"
          ? parsed.winner_model_id
          : null;
      const reasoning =
        parsed && typeof parsed.reasoning === "string"
          ? parsed.reasoning
          : undefined;

      if (votedModelId && globalScores[votedModelId] != null) {
        globalScores[votedModelId] += 1;
      }

      judgesResults.push({
        judgeModelId: judge.model,
        votedModelId,
        reasoning,
      });
    } catch {
      judgesResults.push({
        judgeModelId: judge.model,
        votedModelId: null,
      });
    }
  });

  await Promise.all(judgePromises);

  let winnerModelId: string | null = null;
  let bestScore = -1;
  for (const [modelId, score] of Object.entries(globalScores)) {
    if (score > bestScore) {
      bestScore = score;
      winnerModelId = modelId;
    }
  }

  const winnerIndex =
    winnerModelId != null
      ? answers.find((a) => a.model === winnerModelId)?.index ?? null
      : null;

  return {
    scores: globalScores,
    winnerModelId,
    winnerIndex,
    judges: judgesResults,
  };
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const referer = process.env.OPENROUTER_REFERER;
  const siteTitle = process.env.OPENROUTER_SITE_TITLE;

  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing OPENROUTER_API_KEY in environment" },
      { status: 500 },
    );
  }

  let body: ChatRequestBody;

  try {
    body = await req.json();
  } catch (error) {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return NextResponse.json(
      { error: "'messages' array is required" },
      { status: 400 },
    );
  }
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  if (referer) {
    baseHeaders["HTTP-Referer"] = referer;
  }

  if (siteTitle) {
    baseHeaders["X-Title"] = siteTitle;
  }

  try {
    const activeModelIds = Array.isArray(body.activeModels)
      ? body.activeModels.filter((m): m is string => typeof m === "string" && m.length > 0)
      : null;

    const activeModelSet = activeModelIds ? new Set(activeModelIds) : null;

    const allModels = [
      {
        modelId: NVIDIA_MODEL,
        label: "nvidia",
        makePayload: () => {
          const payload: Record<string, unknown> = {
            model: NVIDIA_MODEL,
            messages: body.messages!,
          };
          // Allow client to control reasoning, default to enabled if not provided
          payload.reasoning =
            body.reasoning !== undefined ? body.reasoning : { enabled: true };
          return payload;
        },
      },
      {
        modelId: MISTRAL_MODEL,
        label: "mistral",
        makePayload: () => ({
          model: MISTRAL_MODEL,
          messages: body.messages!,
        }),
      },
      {
        modelId: MOLMO_MODEL,
        label: "molmo",
        makePayload: () => ({
          model: MOLMO_MODEL,
          messages: body.messages!,
        }),
      },
      {
        modelId: TNG_MODEL,
        label: "tng",
        makePayload: () => ({
          model: TNG_MODEL,
          messages: body.messages!,
        }),
      },
      {
        modelId: GEMMA_MODEL,
        label: "gemma",
        makePayload: () => ({
          model: GEMMA_MODEL,
          messages: body.messages!,
        }),
      },
      {
        modelId: MIMO_MODEL,
        label: "mimo",
        makePayload: () => {
          const payload: Record<string, unknown> = {
            model: MIMO_MODEL,
            messages: body.messages!,
          };
          // Enable reasoning for Mimo as well
          payload.reasoning =
            body.reasoning !== undefined ? body.reasoning : { enabled: true };
          return payload;
        },
      },
    ] as const;

    const modelsToCall = activeModelSet
      ? allModels.filter((m) => activeModelSet.has(m.modelId))
      : allModels;

    if (modelsToCall.length === 0) {
      return NextResponse.json(
        { error: "No models selected to call" },
        { status: 400 },
      );
    }

    const responses = await Promise.all(
      modelsToCall.map(async ({ modelId, label, makePayload }) => {
        const res = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: baseHeaders,
          body: JSON.stringify(makePayload()),
        });
        return { modelId, label, res } as const;
      }),
    );

    const modelStatuses: Record<
      string,
      {
        ok: boolean;
        status: number;
        body?: string;
      }
    > = {};

    await Promise.all(
      responses.map(async ({ modelId, res }) => {
        if (res.ok) {
          modelStatuses[modelId] = {
            ok: true,
            status: res.status,
          };
        } else {
          let bodyText: string | undefined;
          try {
            bodyText = await res.text();
          } catch {
            bodyText = undefined;
          }
          modelStatuses[modelId] = {
            ok: false,
            status: res.status,
            body: bodyText && bodyText.length > 0 ? bodyText : undefined,
          };
        }
      }),
    );

    const successful = responses.filter((r) => r.res.ok);

    if (successful.length === 0) {
      return NextResponse.json(
        {
          error: "OpenRouter API error",
          details: modelStatuses,
        },
        { status: 502 },
      );
    }

    const rawByLabel: Record<string, any> = {};
    const choices: unknown[] = [];

    for (const { modelId, label, res } of successful) {
      const data = await res.json();
      rawByLabel[label] = data;
      const choice = data?.choices?.[0];
      if (choice?.message) {
        choices.push({
          model: modelId,
          message: choice.message,
        });
      }
    }

    const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
    const userQuestion =
      lastUser && typeof lastUser.content === "string"
        ? lastUser.content
        : null;

    const evaluation = await runCrossEvaluation(
      choices as any[],
      baseHeaders,
      userQuestion,
    );

    return NextResponse.json({
      choices,
      nvidiaRaw: rawByLabel["nvidia"] ?? null,
      mistralRaw: rawByLabel["mistral"] ?? null,
      molmoRaw: rawByLabel["molmo"] ?? null,
      tngRaw: rawByLabel["tng"] ?? null,
      gemmaRaw: rawByLabel["gemma"] ?? null,
      mimoRaw: rawByLabel["mimo"] ?? null,
      evaluation,
      modelStatuses,
    });
  } catch (error) {
    console.error("Error calling OpenRouter:", error);
    return NextResponse.json(
      { error: "Failed to call OpenRouter API" },
      { status: 500 },
    );
  }
}
