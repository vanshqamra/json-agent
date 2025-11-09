"use client";

import { useMemo, useState } from "react";

export default function HomePage() {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const pageList = useMemo(
    () => result?.pages_preview ?? result?.pages ?? result?.analyzed_pages ?? [],
    [result]
  );

  const groupsPreview = useMemo(() => {
    if (!Array.isArray(result?.groups)) return [];
    return result.groups.slice(0, 5).map((group) => ({
      title: group.title,
      category: group.category,
      variants: Array.isArray(group.variants) ? group.variants.length : 0,
      pageRange: group.pageStart
        ? `${group.pageStart}${group.pageEnd && group.pageEnd !== group.pageStart ? `–${group.pageEnd}` : ""}`
        : "",
    }));
  }, [result]);

  const validationIssues = useMemo(() => {
    const errors = result?.validation?.errors ?? [];
    return errors.slice(0, 10);
  }, [result]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!file) {
      setError("Please choose a PDF first.");
      return;
    }
    try {
      setLoading(true);
      const fd = new FormData();
      fd.append("file", file);

      const res = await fetch("/api/ingest/parse", {
        method: "POST",
        body: fd,
      });
      const contentType = res.headers.get("content-type") || "";
      let payload;
      if (contentType.includes("application/json")) {
        payload = await res.json();
      } else {
        const text = await res.text();
        throw new Error(
          `Unexpected response (${res.status}): ${text.slice(0, 120)}`
        );
      }
      if (!res.ok) {
        const message =
          payload?.error?.message || payload?.error || "Upload failed";
        throw new Error(message);
      }
      setResult(payload);
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
        Chemical JSON Agent
      </h1>
      <p style={{ opacity: 0.9, marginBottom: 24 }}>
        Upload a price-list PDF. We extract per-page text and run the pipeline.
      </p>

      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            background: loading ? "#334155" : "#06b6d4",
            color: "#0b1220",
            fontWeight: 700,
            border: "none",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Processing…" : "Ingest PDF"}
        </button>
      </form>

      {error && (
        <div
          style={{
            background: "#7f1d1d",
            color: "#fecaca",
            padding: 12,
            borderRadius: 8,
            marginBottom: 16,
          }}
        >
          {String(error)}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 24 }}>
          <section>
            <h3>Pipeline summary</h3>
            <div
              style={{
                background: "#0f172a",
                padding: 16,
                borderRadius: 10,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div>
                <strong>Status:</strong> {result.status || "unknown"}
              </div>
              <div>
                <strong>Groups detected:</strong> {result.groups?.length || 0}
              </div>
              <div>
                <strong>LLM:</strong>{" "}
                {result.llm?.configured
                  ? result.llm?.used
                    ? "used"
                    : "available but not used"
                  : result.llm?.enabled === false
                  ? "disabled"
                  : "not configured"}
              </div>
            </div>
          </section>

          <section>
            <h3>First 5 page previews</h3>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                background: "#0f172a",
                padding: 12,
                borderRadius: 8,
                maxHeight: 420,
                overflow: "auto",
              }}
            >
              {JSON.stringify(pageList.slice(0, 5), null, 2)}
            </pre>
          </section>

          {!!groupsPreview.length && (
            <section>
              <h3>Groups (first {groupsPreview.length})</h3>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  background: "#0f172a",
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                <thead>
                  <tr style={{ background: "#1e293b" }}>
                    <th style={{ padding: 8, textAlign: "left" }}>Title</th>
                    <th style={{ padding: 8, textAlign: "left" }}>Category</th>
                    <th style={{ padding: 8, textAlign: "right" }}>Variants</th>
                    <th style={{ padding: 8, textAlign: "right" }}>Pages</th>
                  </tr>
                </thead>
                <tbody>
                  {groupsPreview.map((group) => (
                    <tr key={`${group.title}-${group.pageRange}`}>
                      <td style={{ padding: 8, borderTop: "1px solid #1f2937" }}>{group.title}</td>
                      <td style={{ padding: 8, borderTop: "1px solid #1f2937" }}>{group.category}</td>
                      <td
                        style={{
                          padding: 8,
                          borderTop: "1px solid #1f2937",
                          textAlign: "right",
                        }}
                      >
                        {group.variants}
                      </td>
                      <td
                        style={{
                          padding: 8,
                          borderTop: "1px solid #1f2937",
                          textAlign: "right",
                        }}
                      >
                        {group.pageRange}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {!!result.warnings?.length && (
            <section>
              <h3>Warnings</h3>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {result.warnings.slice(0, 10).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </section>
          )}

          {!!validationIssues.length && (
            <section>
              <h3>Validation issues</h3>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {validationIssues.map((issue, index) => (
                  <li key={`${issue.kind || "issue"}-${index}`}>
                    <code>{issue.kind ?? "group"}</code>: {issue.title ?? issue.reference ?? "unknown"}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <details>
            <summary>Full JSON (debug)</summary>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                background: "#0f172a",
                padding: 12,
                borderRadius: 8,
                maxHeight: 600,
                overflow: "auto",
              }}
            >
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </main>
  );
}
