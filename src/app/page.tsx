"use client";

import { FormEvent, useState } from "react";

const MODEL_COLUMNS = [
  {
    key: "nvidia",
    title: "Nvidia Nemotron",
    modelId: "nvidia/nemotron-3-nano-30b-a3b:free",
  },
  {
    key: "mistral",
    title: "Mistral Devstral",
    modelId: "mistralai/devstral-2512:free",
  },
  {
    key: "molmo",
    title: "Molmo Vision",
    modelId: "allenai/molmo-2-8b:free",
  },
  {
    key: "tng",
    title: "TNG R1T Chimera",
    modelId: "tngtech/tng-r1t-chimera:free",
  },
  {
    key: "gemma",
    title: "Gemma 3n",
    modelId: "google/gemma-3n-e4b-it:free",
  },
  {
    key: "mimo",
    title: "Mimo v2 Flash",
    modelId: "xiaomi/mimo-v2-flash:free",
  },
] as const;

const MODEL_ID_TO_KEY = MODEL_COLUMNS.reduce(
  (acc, column) => {
    acc[column.modelId] = column.key;
    return acc;
  },
  {} as Record<string, string>,
);

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  reasoning_details?: unknown;
  model?: string;
};

function renderReasoning(reasoning: unknown) {
  if (reasoning == null) return null;

  const raw = reasoning as any;
  let text: string;

  if (Array.isArray(raw)) {
    const parts = raw
      .map((item: any) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof item.text === "string") {
          return item.text;
        }
        return JSON.stringify(item, null, 2);
      })
      .filter((part: string) => part.trim().length > 0);

    text = parts.join("\n\n");
  } else if (typeof raw === "string") {
    text = raw;
  } else if (raw && typeof raw === "object" && typeof raw.text === "string") {
    text = raw.text;
  } else {
    text = JSON.stringify(raw, null, 2);
  }

  if (!text.trim()) return null;

  return (
    <div
      style={{
        marginTop: "0.35rem",
        fontSize: "0.8rem",
        background: "#f9fafb",
        padding: "0.5rem",
        borderRadius: 6,
        border: "1px solid #e5e7eb",
      }}
    >
      <div
        style={{
          marginBottom: "0.25rem",
          color: "#4b5563",
          fontWeight: 500,
        }}
      >
        Reasoning
      </div>
      <pre
        style={{
          margin: 0,
          fontSize: "0.8rem",
          overflowX: "auto",
          whiteSpace: "pre-wrap",
        }}
      >
        {text}
      </pre>
    </div>
  );
}

type EvaluationSummary = {
  winnerModelId: string | null;
  scores: Record<string, number>;
  judges: {
    judgeModelId: string;
    votedModelId: string | null;
    reasoning?: string;
  }[];
} | null;

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [winnerModelId, setWinnerModelId] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationSummary>(null);

  const [enabledModels, setEnabledModels] = useState<Record<string, boolean>>(
    () =>
      MODEL_COLUMNS.reduce((acc, column) => {
        acc[column.key] = true;
        return acc;
      }, {} as Record<string, boolean>),
  );

  function autoDisableFromStatuses(statuses: any) {
    if (!statuses || typeof statuses !== "object") return;

    const toDisable: string[] = [];

    for (const [modelId, info] of Object.entries<any>(statuses)) {
      if (!info || typeof info !== "object") continue;

      const ok = info.ok;
      const status = info.status;
      const bodyTextRaw =
        typeof info.body === "string"
          ? info.body
          : typeof info.errorBody === "string"
          ? info.errorBody
          : "";

      if (!(ok === false || (typeof status === "number" && status >= 400))) {
        continue;
      }

      const lower = bodyTextRaw.toLowerCase();
      const looksLikeLimit =
        status === 402 ||
        status === 429 ||
        lower.includes("quota") ||
        lower.includes("rate limit") ||
        lower.includes("limit") ||
        lower.includes("insufficient") ||
        lower.includes("billing") ||
        lower.includes("payment");

      if (!looksLikeLimit) continue;

      const key = MODEL_ID_TO_KEY[modelId];
      if (key) {
        toDisable.push(key);
      }
    }

    if (toDisable.length > 0) {
      setEnabledModels((prev) => {
        const next = { ...prev };
        for (const key of toDisable) {
          next[key] = false;
        }
        return next;
      });
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const activeModelIds = MODEL_COLUMNS.filter(
      (column) => enabledModels[column.key] !== false,
    ).map((column) => column.modelId);

    if (activeModelIds.length === 0) {
      setError("Please enable at least one model.");
      return;
    }

    const newUserMessage: ChatMessage = {
      role: "user",
      content: trimmed,
    };

    const historyForApi = messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.reasoning_details
        ? { reasoning_details: m.reasoning_details }
        : {}),
    }));

    const payload = {
      messages: [...historyForApi, newUserMessage],
      // Enable reasoning on the first turn by default; subsequent turns
      // can continue reasoning because we preserve reasoning_details.
      reasoning: messages.length === 0 ? { enabled: true } : undefined,
      activeModels: activeModelIds,
    };

    setIsLoading(true);
    setInput("");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => ({}))) as any;

        let message =
          (errorBody && typeof errorBody.error === "string"
            ? errorBody.error
            : null) || "Request failed";

        if (errorBody && errorBody.details && typeof errorBody.details === "object") {
          const detailLines: string[] = [];
          for (const [modelId, info] of Object.entries(errorBody.details)) {
            if (!info || typeof info !== "object") continue;
            const status = (info as any).status;
            const body = (info as any).body;
            const parts: string[] = [];
            if (typeof status === "number") {
              parts.push(`status ${status}`);
            }
            if (typeof body === "string" && body.trim().length > 0) {
              const snippet = body.length > 200 ? body.slice(0, 200) + "…" : body;
              parts.push(`body: ${snippet}`);
            }
            if (parts.length > 0) {
              detailLines.push(`${modelId}: ${parts.join(", ")}`);
            }
          }

          if (detailLines.length > 0) {
            message += " | Details: " + detailLines.join(" | ");
          }

          autoDisableFromStatuses(errorBody.details);
        }

        setError(message);
        setMessages((prev) => [...prev, newUserMessage]);
        setIsLoading(false);
        return;
      }

      const data = await response.json();
      const choices = Array.isArray(data?.choices) ? data.choices : [];

      if (!choices.length) {
        throw new Error("No messages returned from models");
      }

      const assistantMessages: ChatMessage[] = choices
        .map((choice: any) => {
          const message = choice?.message;
          if (!message) return null;

          return {
            role: "assistant" as const,
            content: message.content ?? "",
            reasoning_details: message.reasoning_details,
            model: typeof choice.model === "string" ? choice.model : undefined,
          } satisfies ChatMessage;
        })
        .filter((m: any): m is ChatMessage => m !== null);

      const evalObj =
        data && typeof data.evaluation === "object" ? data.evaluation : null;

      const apiWinnerModelId =
        evalObj && typeof evalObj.winnerModelId === "string"
          ? evalObj.winnerModelId
          : null;

      if (data && data.modelStatuses && typeof data.modelStatuses === "object") {
        autoDisableFromStatuses(data.modelStatuses);
      }

      setWinnerModelId(apiWinnerModelId);
      setEvaluation(
        evalObj
          ? {
              winnerModelId: apiWinnerModelId,
              scores:
                evalObj.scores && typeof evalObj.scores === "object"
                  ? evalObj.scores
                  : {},
              judges: Array.isArray(evalObj.judges) ? evalObj.judges : [],
            }
          : null,
      );
      setMessages((prev) => [...prev, newUserMessage, ...assistantMessages]);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Unknown error");
      setMessages((prev) => [...prev, newUserMessage]);
    } finally {
      setIsLoading(false);
    }
  }

  const columnMessages: Record<string, ChatMessage[]> = {
    nvidia: [],
    mistral: [],
    molmo: [],
    tng: [],
     gemma: [],
     mimo: [],
  };

  for (const message of messages) {
    if (message.role === "user") {
      for (const column of MODEL_COLUMNS) {
        columnMessages[column.key].push(message);
      }
      continue;
    }

    if (message.role === "assistant" && message.model) {
      const column = MODEL_COLUMNS.find((col) => col.modelId === message.model);
      if (column) {
        columnMessages[column.key].push(message);
      }
    }
  }

  return (
    <main
      style={{
        padding: "2rem 1.5rem 1.5rem",
        fontFamily: "system-ui, sans-serif",
        maxWidth: 1400,
        margin: "0 auto",
        minHeight: "100vh",
        background: "#f3f4f6",
      }}
    >
      <header
        style={{
          marginBottom: "1.5rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.35rem",
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: "1.6rem",
            fontWeight: 650,
            color: "#0f172a",
          }}
        >
          Compare Models Side by Side
        </h1>
        <p style={{ margin: 0, color: "#4b5563", fontSize: "0.9rem" }}>
          Ask once and see how each model answers in its own panel.
        </p>
      </header>

      <div
        style={{
          marginBottom: "1rem",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <span style={{ fontSize: "0.85rem", color: "#4b5563" }}>Models:</span>
        {MODEL_COLUMNS.map((column) => (
          <label
            key={column.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.25rem",
              fontSize: "0.8rem",
              padding: "0.15rem 0.5rem",
              borderRadius: 999,
              background: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={enabledModels[column.key] !== false}
              onChange={(event) => {
                const checked = event.target.checked;
                setEnabledModels((prev) => ({
                  ...prev,
                  [column.key]: checked,
                }));
              }}
            />
            <span>{column.title}</span>
          </label>
        ))}
      </div>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: "1rem",
          marginBottom: "1rem",
        }}
      >
        {MODEL_COLUMNS.filter(
          (column) => enabledModels[column.key] !== false,
        ).map((column) => {
          const items = columnMessages[column.key];
          const isWinner = winnerModelId === column.modelId;

          return (
            <div
              key={column.key}
              style={{
                border: isWinner ? "2px solid #16a34a" : "1px solid #e5e7eb",
                boxShadow: isWinner
                  ? "0 0 0 1px rgba(22,163,74,0.25), 0 10px 15px -3px rgba(0,0,0,0.08)"
                  : "0 4px 6px rgba(15,23,42,0.05)",
                borderRadius: 10,
                background: "#ffffff",
                display: "flex",
                flexDirection: "column",
                maxHeight: "60vh",
              }}
            >
              <header
                style={{
                  padding: "0.75rem 1rem",
                  borderBottom: "1px solid #e5e5e5",
                  fontWeight: 600,
                  fontSize: "0.95rem",
                  background: isWinner ? "#ecfdf3" : "#f3f4f6",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span>{column.title}</span>
                {isWinner && (
                  <span
                    style={{
                      fontSize: "0.75rem",
                      padding: "0.15rem 0.4rem",
                      borderRadius: 999,
                      background: "#16a34a",
                      color: "#ffffff",
                      fontWeight: 500,
                    }}
                  >
                    Best
                  </span>
                )}
              </header>
              <div
                style={{
                  padding: "0.75rem 1rem",
                  overflowY: "auto",
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                }}
              >
                {items.length === 0 ? (
                  <p
                    style={{
                      color: "#9ca3af",
                      fontSize: "0.85rem",
                    }}
                  >
                    No messages yet for this model.
                  </p>
                ) : (
                  items.map((message, index) => (
                    <div
                      key={index}
                      style={{
                        alignSelf:
                          message.role === "user" ? "flex-end" : "flex-start",
                        maxWidth: "100%",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: "#6b7280",
                          marginBottom: "0.15rem",
                          textAlign:
                            message.role === "user" ? "right" : "left",
                        }}
                      >
                        {message.role === "user" ? "You" : column.title}
                      </div>
                      <div
                        style={{
                          backgroundColor:
                            message.role === "user" ? "#111827" : "#ffffff",
                          color:
                            message.role === "user" ? "#ffffff" : "#111827",
                          padding: "0.5rem 0.75rem",
                          borderRadius: 12,
                          border:
                            message.role === "user"
                              ? "1px solid #111827"
                              : "1px solid #e5e7eb",
                          fontSize: "0.9rem",
                          whiteSpace: "pre-wrap",
                          boxShadow:
                            "0 1px 2px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.1)",
                        }}
                      >
                        {message.content}
                      </div>

                      {message.role === "assistant" &&
                        renderReasoning(message.reasoning_details)}
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </section>

      {evaluation && evaluation.winnerModelId && (
        <div
          style={{
            position: "fixed",
            right: "1.5rem",
            bottom: "1.5rem",
            maxWidth: 360,
            background: "#111827",
            color: "#f9fafb",
            padding: "0.75rem 0.9rem",
            borderRadius: 12,
            boxShadow:
              "0 10px 15px -3px rgba(0,0,0,0.4), 0 4px 6px -4px rgba(0,0,0,0.3)",
            fontSize: "0.85rem",
            zIndex: 40,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: "0.5rem",
            }}
          >
            <div>
              <div
                style={{
                  fontWeight: 600,
                  marginBottom: "0.25rem",
                }}
              >
                Best answer: {
                  MODEL_COLUMNS.find(
                    (c) => c.modelId === evaluation.winnerModelId,
                  )?.title ?? evaluation.winnerModelId
                }
              </div>
              {evaluation.judges.length > 0 && (
                <div style={{ opacity: 0.9 }}>
                  {evaluation.judges
                    .map((j) => j.reasoning)
                    .filter((r): r is string => !!r && r.trim().length > 0)[0] && (
                    <p style={{ margin: 0 }}>
                      {
                        evaluation.judges
                          .map((j) => j.reasoning)
                          .filter(
                            (r): r is string => !!r && r.trim().length > 0,
                          )[0]
                      }
                    </p>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setEvaluation(null)}
              style={{
                border: "none",
                background: "transparent",
                color: "#9ca3af",
                cursor: "pointer",
                fontSize: "0.85rem",
                padding: 0,
              }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {error && (
        <p style={{ color: "#b00020", marginBottom: "0.75rem" }}>{error}</p>
      )}

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: "0.5rem" }}>
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Type your question..."
          style={{
            flex: 1,
            padding: "0.5rem 0.75rem",
            borderRadius: 4,
            border: "1px solid #ccc",
            fontSize: "1rem",
          }}
        />
        <button
          type="submit"
          disabled={isLoading}
          style={{
            padding: "0.5rem 1rem",
            borderRadius: 4,
            border: "none",
            background: isLoading ? "#888" : "#111827",
            color: "#fff",
            cursor: isLoading ? "default" : "pointer",
            fontSize: "1rem",
          }}
        >
          {isLoading ? "Thinking..." : "Send"}
        </button>
      </form>
    </main>
  );
}
