"use client";

import { useMemo, useState } from "react";

export default function HomePage() {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const pageList = useMemo(
    () => result?.pages ?? result?.analyzed_pages ?? [],
    [result]
  );

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
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Upload failed");
      setResult(json);
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
        <div style={{ marginTop: 16 }}>
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

          {result.groups?.length ? (
            <>
              <h3 style={{ marginTop: 24 }}>Detected groups (early pass)</h3>
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
                {JSON.stringify(result.groups, null, 2)}
              </pre>
            </>
          ) : null}

          <details style={{ marginTop: 16 }}>
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
