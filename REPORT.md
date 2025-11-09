# Build Fix Summary

## Root Cause
- The parser imported `pdfjs-dist/legacy/build/pdf.js`, whose bundler entry eagerly required the optional `canvas` package. When Next.js bundled the API route for Vercel, that hard dependency caused build-time failures because `canvas` cannot be resolved in the serverless environment.
- The legacy entry also expected a bundled worker file, which triggered runtime failures (`pdfjs_module_unavailable` and missing `pdf.worker.js`).

## Key Changes
- Added `lib/pdfjsNodeLoader.js` to dynamically import the standard `pdfjs-dist/build/pdf.js` entry (attempting the ESM build first) only on the server, configure worker options (`disableWorker: true`), and preload the worker message handler directly from `pdf.worker.js` without copying worker assets.
- Updated `lib/pdfSegmenter.js` to consume the new loader, pass `disableWorker: true` to `getDocument`, and lazily import `canvas` via `loadCanvasSafe()`, emitting a consistent `CANVAS_UNAVAILABLE` diagnostic when the module is missing.
- Wrapped optional `canvas` usage in dynamic imports so OCR is skipped gracefully when unavailable, while preserving text extraction behaviour.
- Extended `next.config.js` to treat `canvas` as an external dependency on the server build, preventing Webpack from bundling it.

## Notes
- Installed `pdfjs-dist` version: 3.11.174 (`build/pdf.js` fallback used because the package omits `build/pdf.mjs`).
- No business logic (pattern registry, scoring, LLM usage, etc.) was modified—only module loading and build configuration were touched.


## Diffs

### lib/pdfjsNodeLoader.js
```diff
diff --git a/lib/pdfjsNodeLoader.js b/lib/pdfjsNodeLoader.js
new file mode 100644
index 0000000..9678474
--- /dev/null
+++ b/lib/pdfjsNodeLoader.js
@@ -0,0 +1,79 @@
+let cachedPdfjsLib = null;
+let pdfjsLoadError = null;
+let loadingPromise = null;
+
+export async function getPdfjs() {
+  if (cachedPdfjsLib) {
+    return cachedPdfjsLib;
+  }
+  if (pdfjsLoadError) {
+    throw pdfjsLoadError;
+  }
+  if (typeof window !== 'undefined') {
+    throw new Error('pdfjs should not be loaded on the client');
+  }
+  if (!loadingPromise) {
+    loadingPromise = (async () => {
+      try {
+        let pdfjsModule;
+        try {
+          pdfjsModule = await import(/* webpackIgnore: true */ 'pdfjs-dist/build/pdf.mjs');
+        } catch (importError) {
+          const message = importError?.message || '';
+          if (
+            importError?.code === 'ERR_MODULE_NOT_FOUND' ||
+            /Cannot find module|Cannot resolve module/i.test(message)
+          ) {
+            pdfjsModule = await import('pdfjs-dist/build/pdf.js');
+          } else {
+            throw importError;
+          }
+        }
+        const pdfjsLib = pdfjsModule?.default ?? pdfjsModule;
+        if (!pdfjsLib?.getDocument) {
+          throw new Error('getDocument export missing');
+        }
+        if (pdfjsLib?.GlobalWorkerOptions) {
+          pdfjsLib.GlobalWorkerOptions.workerSrc = undefined;
+          pdfjsLib.GlobalWorkerOptions.workerPort = null;
+          if ('disableWorker' in pdfjsLib.GlobalWorkerOptions) {
+            pdfjsLib.GlobalWorkerOptions.disableWorker = true;
+          }
+        }
+        if (pdfjsLib?.PDFWorkerUtil) {
+          pdfjsLib.PDFWorkerUtil.isWorkerDisabled = true;
+          pdfjsLib.PDFWorkerUtil.fallbackWorkerSrc = null;
+        }
+        if (pdfjsLib?.PDFWorker) {
+          try {
+            const workerModule = await import('pdfjs-dist/build/pdf.worker.js');
+            const workerHandler =
+              workerModule?.WorkerMessageHandler ||
+              workerModule?.default?.WorkerMessageHandler ||
+              workerModule?.default;
+            if (workerHandler) {
+              Object.defineProperty(pdfjsLib.PDFWorker, '_setupFakeWorkerGlobal', {
+                value: Promise.resolve(workerHandler),
+                configurable: true,
+                enumerable: false,
+                writable: true,
+              });
+            }
+          } catch (workerError) {
+            console.warn('[pdfjs worker preload failed]', workerError);
+          }
+        }
+        pdfjsLib.disableWorker = true;
+        cachedPdfjsLib = pdfjsLib;
+        return pdfjsLib;
+      } catch (error) {
+        const wrapped = new Error('pdfjs_module_unavailable');
+        wrapped.code = 'PDFJS_UNAVAILABLE';
+        wrapped.cause = error;
+        pdfjsLoadError = wrapped;
+        throw wrapped;
+      }
+    })();
+  }
+  return loadingPromise;
+}
```

### lib/pdfSegmenter.js
```diff
diff --git a/lib/pdfSegmenter.js b/lib/pdfSegmenter.js
index 2f2ffd2..f4cda73 100644
--- a/lib/pdfSegmenter.js
+++ b/lib/pdfSegmenter.js
@@ -1,15 +1,32 @@
-import { createRequire } from 'node:module';
+import { getPdfjs } from './pdfjsNodeLoader.js';
 
-const require = createRequire(import.meta.url);
-
-let createCanvasFn = null;
-let canvasAvailable = true;
+let canvasModulePromise = null;
 let canvasLoadError = null;
-try {
-  ({ createCanvas: createCanvasFn } = require('canvas'));
-} catch (error) {
-  canvasAvailable = false;
-  canvasLoadError = error;
+
+async function loadCanvasSafe() {
+  if (!canvasModulePromise) {
+    canvasModulePromise = (async () => {
+      try {
+        const canvasModule = await import('canvas');
+        if (canvasModule?.createCanvas) {
+          return canvasModule;
+        }
+        canvasLoadError = new Error('createCanvas export missing');
+        return null;
+      } catch (error) {
+        canvasLoadError = error;
+        return null;
+      }
+    })();
+  }
+  return canvasModulePromise;
+}
+
+function createCanvasUnavailableError() {
+  const error = new Error('canvas_module_unavailable');
+  error.code = 'CANVAS_UNAVAILABLE';
+  error.cause = canvasLoadError;
+  return error;
 }
 
 let createWorkerFactory = null;
@@ -43,27 +60,19 @@ async function getCreateWorker() {
   }
 }
 
-function ensureCanvasAvailable() {
-  if (!canvasAvailable || typeof createCanvasFn !== 'function') {
-    const error = new Error('canvas_module_unavailable');
-    error.code = 'CANVAS_UNAVAILABLE';
-    error.cause = canvasLoadError;
-    throw error;
-  }
-}
-
 const FIGURE_RE = /^(fig(?:ure)?\.?|image|illustration)\b/i;
 const TABLE_ROW_RE = /(\s{2,}|\t|\|)|\d+\s*[x×]\s*\d+/i;
 const HEADER_ROW_RE = /[A-Za-z][A-Za-z\s\/()%-]{2,}/;
 
 const PRICE_STRIP_RE = /\s+/g;
 
-let cachedPdfjsLib = null;
-
 class NodeCanvasFactory {
+  constructor(createCanvas) {
+    this.createCanvas = createCanvas;
+  }
+
   create(width, height) {
-    ensureCanvasAvailable();
-    const canvas = createCanvasFn(Math.max(width, 1), Math.max(height, 1));
+    const canvas = this.createCanvas(Math.max(width, 1), Math.max(height, 1));
     const context = canvas.getContext('2d');
     return { canvas, context };
   }
@@ -405,10 +414,13 @@ export function segmentPageText(pageText, pageNumber, options = {}) {
   return page;
 }
 
-async function renderPageToImage(page, scale = 2) {
-  ensureCanvasAvailable();
+async function renderPageToImage(page, scale = 2, canvasModule) {
+  const resolvedCanvasModule = canvasModule ?? (await loadCanvasSafe());
+  if (!resolvedCanvasModule?.createCanvas) {
+    throw createCanvasUnavailableError();
+  }
+  const canvasFactory = new NodeCanvasFactory(resolvedCanvasModule.createCanvas);
   const viewport = page.getViewport({ scale });
-  const canvasFactory = new NodeCanvasFactory();
   const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
   const renderContext = {
     canvasContext: context,
@@ -430,9 +442,12 @@ async function extractPdfTextFromPage(page) {
 }
 
 async function extractOcrText(page) {
-  ensureCanvasAvailable();
+  const canvasModule = await loadCanvasSafe();
+  if (!canvasModule?.createCanvas) {
+    throw createCanvasUnavailableError();
+  }
   const worker = await getOcrWorker();
-  const imageBuffer = await renderPageToImage(page, 2);
+  const imageBuffer = await renderPageToImage(page, 2, canvasModule);
   const { data } = await worker.recognize(imageBuffer, { lang: 'eng' });
   const rawText = String(data?.text || '');
   const lines = rawText
@@ -448,28 +463,18 @@ async function extractOcrText(page) {
 }
 
 export async function extractPdfText(bufferOrArrayBuffer) {
-  let pdfjsLib = cachedPdfjsLib;
-  if (!pdfjsLib) {
-    if (typeof window !== 'undefined') {
-      throw new Error('pdfjs should not be loaded on the client');
-    }
-    try {
-      const pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.js');
-      pdfjsLib = pdfjsModule?.default ?? pdfjsModule;
-      if (pdfjsLib?.GlobalWorkerOptions) {
-        pdfjsLib.GlobalWorkerOptions.workerSrc = undefined;
-      }
-      if (typeof pdfjsLib?.getDocument !== 'function') {
-        throw new Error('getDocument export missing');
-      }
-      cachedPdfjsLib = pdfjsLib;
-    } catch (error) {
-      console.error('[pdfjs import failed]', error);
-      const wrapped = new Error('pdfjs_module_unavailable');
-      wrapped.code = 'PDFJS_UNAVAILABLE';
-      wrapped.cause = error;
-      throw wrapped;
+  let pdfjsLib;
+  try {
+    pdfjsLib = await getPdfjs();
+  } catch (error) {
+    console.error('[pdfjs import failed]', error);
+    if (error?.code === 'PDFJS_UNAVAILABLE') {
+      throw error;
     }
+    const wrapped = new Error('pdfjs_module_unavailable');
+    wrapped.code = 'PDFJS_UNAVAILABLE';
+    wrapped.cause = error;
+    throw wrapped;
   }
   const data = bufferOrArrayBuffer instanceof Uint8Array
     ? new Uint8Array(
@@ -481,6 +486,7 @@ export async function extractPdfText(bufferOrArrayBuffer) {
 
   const loadingTask = pdfjsLib.getDocument({
     data,
+    disableWorker: true,
     useWorkerFetch: false,
     disableFontFace: true,
     isEvalSupported: false,
```

### next.config.js
```diff
diff --git a/next.config.js b/next.config.js
index 3b8c1a5..a75f9bf 100644
--- a/next.config.js
+++ b/next.config.js
@@ -1,3 +1,11 @@
-const nextConfig = {};
+const nextConfig = {
+  webpack: (config, { isServer }) => {
+    if (isServer) {
+      config.externals = config.externals || [];
+      config.externals.push({ canvas: 'commonjs canvas' });
+    }
+    return config;
+  },
+};
 
 export default nextConfig;
```
