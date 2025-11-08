// app/api/ingest/parse/route.js
import pdfParse from 'pdf-parse';

// Pipeline imports via @ alias (now resolved by jsconfig.json)
import { tokenizeAndClassify } from '@/tokenize';
import { markNoise } from '@/noiseFilter';
import { detectGroups } from '@/groupDetector';
import { assembleVariants } from '@/variantAssembler';
import { normalizeGroup } from '@/specNormalizer';
import { postProcess } from '@/postProcessor';
import { maybeEscalateWithLLM } from '@/llmAssist';

// Ensure this route runs on the Edge-compatible Node runtime
export const dynamic = 'force-dynamic';

export async function POST(req) {
  try {
    // Expect a multipart with a field "file" (PDF)
    const formData = await req.formData();
    const file = formData.get('file');
    if (!file) return Response.json({ error: 'No file uploaded' }, { status: 400 });

    const arrayBuf = await file.arrayBuffer();
    const pdfData = await pdfParse(Buffer.from(arrayBuf));

    // Split into pages (pdf-parse gives full text; we split by form-feed if present, else by heuristic)
    const rawPages = pdfData.text.includes('\f')
      ? pdfData.text.split('\f')
      : pdfData.text.split(/\n\s*\n(?=[A-Z0-9].+)/); // fallback heuristic

    // --- Tokenize & classify (with LLM “low-confidence” escalation on ambiguous lines) ---
    let tokenized = tokenizeAndClassify(rawPages);

    // Inject low-confidence escalation you asked for:
    for (const p of tokenized) {
      const patchedBlocks = [];
      for (const b of p.blocks) {
        let block = { ...b };
        const lowConfidence =
          block.type === 'garbage' ||
          block.type === 'text' ||
          (block.type === 'spec_row' && !/\d/.test(block.text));

        if (lowConfidence) {
          const llmHint = await maybeEscalateWithLLM(
            { text: block.text, metrics: block.metrics, type: block.type },
            'Uncertain classification'
          );
          if (llmHint?.suggestedType) block.type = llmHint.suggestedType;
          if (llmHint?.normalized) block.normalized = llmHint.normalized;
        }
        patchedBlocks.push(block);
      }
      p.blocks = patchedBlocks;
    }

    // Mark noise/sections
    const withNoise = markNoise(tokenized);

    // Detect groups
    const rawGroups = detectGroups(withNoise);

    // Assemble variants per group
    const groups = [];
    for (const rg of rawGroups) {
      const variants = assembleVariants(rg, { windowSize: 3 });
      const group = {
        title: rg.title,
        description: rg.lines?.map(l => l.text).join(' ') || '',
        variants
      };
      groups.push(await normalizeGroup(group));
    }

    // Final post-processing (dedupe, price-per-unit, confidence, etc.)
    const finalGroups = await postProcess(groups);

    // Return compact output
    return Response.json({
      meta: {
        pages: rawPages.length,
        variants_total: finalGroups.reduce((s, g) => s + (g.variants?.length || 0), 0)
      },
      pages_preview: withNoise.slice(0, 2), // first 2 pages for UI preview
      groups: finalGroups
    });
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}

// Simple health check for GET
export async function GET() {
  return new Response('ok', { status: 200 });
}
