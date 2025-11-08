// app/api/ingest/parse/route.js
export async function POST() {
  return new Response(
    JSON.stringify({ ok: true, note: "parse endpoint temporarily disabled for deploy" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}