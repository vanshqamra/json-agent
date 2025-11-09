let cachedPdfjsLib = null;
let pdfjsLoadError = null;
let loadingPromise = null;

export async function getPdfjs() {
  if (cachedPdfjsLib) {
    return cachedPdfjsLib;
  }
  if (pdfjsLoadError) {
    throw pdfjsLoadError;
  }
  if (typeof window !== 'undefined') {
    throw new Error('pdfjs should not be loaded on the client');
  }
  if (!loadingPromise) {
    loadingPromise = (async () => {
      try {
        let pdfjsModule;
        try {
          pdfjsModule = await import(/* webpackIgnore: true */ 'pdfjs-dist/build/pdf.mjs');
        } catch (importError) {
          const message = importError?.message || '';
          if (
            importError?.code === 'ERR_MODULE_NOT_FOUND' ||
            /Cannot find module|Cannot resolve module/i.test(message)
          ) {
            pdfjsModule = await import('pdfjs-dist/build/pdf.js');
          } else {
            throw importError;
          }
        }
        const pdfjsLib = pdfjsModule?.default ?? pdfjsModule;
        if (!pdfjsLib?.getDocument) {
          throw new Error('getDocument export missing');
        }
        if (pdfjsLib?.GlobalWorkerOptions) {
          pdfjsLib.GlobalWorkerOptions.workerSrc = undefined;
          pdfjsLib.GlobalWorkerOptions.workerPort = null;
          if ('disableWorker' in pdfjsLib.GlobalWorkerOptions) {
            pdfjsLib.GlobalWorkerOptions.disableWorker = true;
          }
        }
        if (pdfjsLib?.PDFWorkerUtil) {
          pdfjsLib.PDFWorkerUtil.isWorkerDisabled = true;
          pdfjsLib.PDFWorkerUtil.fallbackWorkerSrc = null;
        }
        if (pdfjsLib?.PDFWorker) {
          try {
            const workerModule = await import('pdfjs-dist/build/pdf.worker.js');
            const workerHandler =
              workerModule?.WorkerMessageHandler ||
              workerModule?.default?.WorkerMessageHandler ||
              workerModule?.default;
            if (workerHandler) {
              Object.defineProperty(pdfjsLib.PDFWorker, '_setupFakeWorkerGlobal', {
                value: Promise.resolve(workerHandler),
                configurable: true,
                enumerable: false,
                writable: true,
              });
            }
          } catch (workerError) {
            console.warn('[pdfjs worker preload failed]', workerError);
          }
        }
        pdfjsLib.disableWorker = true;
        cachedPdfjsLib = pdfjsLib;
        return pdfjsLib;
      } catch (error) {
        const wrapped = new Error('pdfjs_module_unavailable');
        wrapped.code = 'PDFJS_UNAVAILABLE';
        wrapped.cause = error;
        pdfjsLoadError = wrapped;
        throw wrapped;
      }
    })();
  }
  return loadingPromise;
}
