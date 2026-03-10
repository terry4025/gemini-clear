document.addEventListener("DOMContentLoaded", () => {
    const OPENCV_SCRIPT_URL = new URL("opencv.js", window.location.href).href;
    const OPENCV_READY_TIMEOUT_MS = 45000;
    const DEFAULT_UPLOAD_MESSAGE = "Supports PNG, JPG, and WEBP. Processing stays local.";
    const MANUAL_PREVIEW_COLOR = "rgba(236, 72, 153, 0.48)";
    const AUTO_FILL_COLOR = "rgba(139, 92, 246, 0.2)";
    const AUTO_STROKE_COLOR = "rgba(167, 139, 250, 0.85)";
    const SUPPORTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
    const EXTENSION_TO_MIME = new Map([
        [".png", "image/png"],
        [".jpg", "image/jpeg"],
        [".jpeg", "image/jpeg"],
        [".webp", "image/webp"]
    ]);

    const UI = {
        zones: {
            upload: document.getElementById("upload-zone"),
            editor: document.getElementById("editor-zone"),
            result: document.getElementById("result-zone")
        },
        dropArea: document.getElementById("drop-area"),
        fileInput: document.getElementById("file-input"),
        btnChooseFile: document.getElementById("btn-choose-file"),
        uploadFeedback: document.getElementById("upload-feedback"),
        imgCanvas: document.getElementById("image-canvas"),
        maskCanvas: document.getElementById("mask-canvas"),
        canvasArea: document.getElementById("canvas-area"),
        canvasWrapper: document.getElementById("canvas-wrapper"),
        editorStatus: document.getElementById("editor-status"),
        maskStatus: document.getElementById("mask-status"),
        outputResolution: document.getElementById("output-resolution"),
        resultResolution: document.getElementById("result-resolution"),
        coverageReadout: document.getElementById("coverage-readout"),
        loadingOverlay: document.getElementById("loading-overlay"),
        loadingMessage: document.getElementById("loading-message"),
        brushSizeInput: document.getElementById("brush-size"),
        brushSizeVal: document.getElementById("brush-size-val"),
        autoDetectToggle: document.getElementById("auto-detect"),
        btnUndo: document.getElementById("btn-undo"),
        btnClear: document.getElementById("btn-clear"),
        btnErase: document.getElementById("btn-erase"),
        btnBack: document.getElementById("btn-back"),
        btnDownload: document.getElementById("btn-download"),
        imgBefore: document.getElementById("img-before"),
        imgAfter: document.getElementById("img-after"),
        comparisonSlider: document.getElementById("comparison-slider"),
        sliderHandle: document.getElementById("slider-handle"),
        imgBeforeWrapper: document.getElementById("img-before-wrapper")
    };

    const buffers = {
        sourceCanvas: document.createElement("canvas"),
        fullMaskCanvas: document.createElement("canvas"),
        resultCanvas: document.createElement("canvas")
    };

    const contexts = {
        preview: UI.imgCanvas.getContext("2d"),
        previewMask: UI.maskCanvas.getContext("2d"),
        source: buffers.sourceCanvas.getContext("2d"),
        fullMask: buffers.fullMaskCanvas.getContext("2d"),
        result: buffers.resultCanvas.getContext("2d")
    };

    const state = {
        cvReady: false,
        cvError: null,
        cvLoadPromise: null,
        imageFile: null,
        originalUrl: "",
        originalImage: null,
        originalWidth: 0,
        originalHeight: 0,
        previewScale: 1,
        previewWidth: 0,
        previewHeight: 0,
        manualStrokes: [],
        activeStroke: null,
        activePointerId: null,
        autoRects: [],
        detecting: false,
        processing: false,
        processedBlob: null,
        processedUrl: "",
        comparisonRatio: 0.5
    };

    const cvWorkerState = {
        worker: null,
        workerUrl: "",
        nextRequestId: 0,
        pending: new Map()
    };

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const isBusy = () => state.detecting || state.processing;
    const summaryHasMask = (summary) => summary !== "empty";

    const safeDelete = (...values) => {
        values.forEach((value) => {
            if (value && typeof value.delete === "function") {
                value.delete();
            }
        });
    };

    const revokeObjectUrl = (url) => {
        if (url) {
            URL.revokeObjectURL(url);
        }
    };

    const formatResolution = (width, height) => width && height
        ? `${width.toLocaleString()} × ${height.toLocaleString()} PNG`
        : "--";

    const sanitizeFileName = (name) => {
        const stem = (name || "GeminiClear_Result").replace(/\.[^.]+$/, "");
        return stem.replace(/[^\w.-]+/g, "_");
    };

    const dataUrlToBlob = (dataUrl) => {
        const [header, encoded] = dataUrl.split(",");
        const mimeMatch = header.match(/:(.*?);/);
        const binary = atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return new Blob([bytes], { type: mimeMatch ? mimeMatch[1] : "image/png" });
    };

    const canvasToBlob = (canvas) => new Promise((resolve, reject) => {
        if (canvas.toBlob) {
            canvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                    return;
                }

                try {
                    resolve(dataUrlToBlob(canvas.toDataURL("image/png")));
                } catch (error) {
                    reject(error);
                }
            }, "image/png", 1);
            return;
        }

        try {
            resolve(dataUrlToBlob(canvas.toDataURL("image/png")));
        } catch (error) {
            reject(error);
        }
    });

    const setImageSource = (element, src) => new Promise((resolve, reject) => {
        element.onload = () => resolve();
        element.onerror = () => reject(new Error("Failed to load processed preview."));
        element.src = src;
        if (element.complete && element.naturalWidth > 0) {
            resolve();
        }
    });

    const loadImageFromUrl = (url) => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Failed to load the selected image."));
        image.src = url;
    });

    const setUploadFeedback = (message, tone = "neutral") => {
        UI.uploadFeedback.textContent = message;
        UI.uploadFeedback.classList.remove("is-error", "is-ready");
        if (tone === "error") UI.uploadFeedback.classList.add("is-error");
        if (tone === "ready") UI.uploadFeedback.classList.add("is-ready");
    };

    const setEditorStatus = (message, tone = "neutral") => {
        UI.editorStatus.textContent = message;
        UI.editorStatus.classList.remove("status-neutral", "status-ready", "status-error");
        UI.editorStatus.classList.add(`status-${tone}`);
    };

    const setLoadingState = (active, message = "") => {
        UI.loadingOverlay.classList.toggle("hidden", !active);
        if (message) UI.loadingMessage.textContent = message;
    };

    const switchZone = (zoneId) => {
        Object.values(UI.zones).forEach((zone) => {
            zone.classList.remove("active");
            zone.classList.add("hidden");
        });
        UI.zones[zoneId].classList.remove("hidden");
        UI.zones[zoneId].classList.add("active");
    };

    const updateResolutionBadges = () => {
        const label = `Output: ${formatResolution(state.originalWidth, state.originalHeight)}`;
        UI.outputResolution.textContent = label;
        UI.resultResolution.textContent = label;
    };

    const getMaskSummary = () => {
        const manualCount = state.manualStrokes.length + (state.activeStroke ? 1 : 0);
        const autoCount = state.autoRects.length;
        const parts = [];
        if (manualCount > 0) parts.push(`${manualCount} manual stroke${manualCount === 1 ? "" : "s"}`);
        if (autoCount > 0) parts.push(`${autoCount} auto region${autoCount === 1 ? "" : "s"}`);
        return parts.length ? parts.join(" + ") : "empty";
    };

    const updateMaskIndicators = () => {
        const summary = getMaskSummary();
        UI.maskStatus.textContent = `Mask: ${summary}`;
        UI.coverageReadout.textContent = summary === "empty" ? "0 mask regions" : summary;
    };

    const hasMask = () => summaryHasMask(getMaskSummary());

    const updateControls = () => {
        const busy = isBusy();
        const imageReady = Boolean(state.originalImage);
        const maskReady = hasMask();

        UI.brushSizeInput.disabled = !imageReady || busy;
        UI.btnUndo.disabled = state.manualStrokes.length === 0 || busy;
        UI.btnClear.disabled = !maskReady || busy;
        UI.autoDetectToggle.disabled = !imageReady || busy;
        UI.btnErase.disabled = !imageReady || !maskReady || busy;
        UI.btnDownload.disabled = !state.processedBlob || busy;
    };

    const waitForNextPaint = () => new Promise((resolve) => {
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(resolve);
        });
    });

    const failPendingCvRequests = (message) => {
        const error = new Error(message);
        cvWorkerState.pending.forEach(({ reject }) => reject(error));
        cvWorkerState.pending.clear();
    };

    const createOpenCvWorkerSource = () => `
const OPENCV_SCRIPT_URL = ${JSON.stringify(OPENCV_SCRIPT_URL)};
const OPENCV_READY_TIMEOUT_MS = ${OPENCV_READY_TIMEOUT_MS};

let cvLoadPromise = null;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const safeDelete = (...values) => {
    values.forEach((value) => {
        if (value && typeof value.delete === "function") {
            value.delete();
        }
    });
};

const clampRect = (rect, width, height) => {
    const x = clamp(Math.round(rect.x), 0, width);
    const y = clamp(Math.round(rect.y), 0, height);
    const maxWidth = Math.max(0, width - x);
    const maxHeight = Math.max(0, height - y);

    return {
        x,
        y,
        width: clamp(Math.round(rect.width), 0, maxWidth),
        height: clamp(Math.round(rect.height), 0, maxHeight)
    };
};

const shouldMergeRects = (first, second, gap) => !(
    first.x + first.width + gap < second.x ||
    second.x + second.width + gap < first.x ||
    first.y + first.height + gap < second.y ||
    second.y + second.height + gap < first.y
);

const mergeRects = (rects, gap) => {
    const pending = [...rects];
    const merged = [];

    while (pending.length) {
        let current = pending.pop();
        let mergedAny = true;

        while (mergedAny) {
            mergedAny = false;
            for (let index = pending.length - 1; index >= 0; index -= 1) {
                if (!shouldMergeRects(current, pending[index], gap)) {
                    continue;
                }

                const candidate = pending[index];
                const minX = Math.min(current.x, candidate.x);
                const minY = Math.min(current.y, candidate.y);
                const maxX = Math.max(current.x + current.width, candidate.x + candidate.width);
                const maxY = Math.max(current.y + current.height, candidate.y + candidate.height);

                current = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
                pending.splice(index, 1);
                mergedAny = true;
            }
        }

        merged.push(current);
    }

    return merged.sort((left, right) => {
        const leftScore = left.x + left.width + left.y + left.height;
        const rightScore = right.x + right.width + right.y + right.height;
        return rightScore - leftScore;
    });
};

const createEllipseRegion = (rect, width, height, options = {}) => {
    const {
        padRatio = 0.16,
        minSize = 24,
        maxWidthRatio = 0.16,
        maxHeightRatio = 0.14,
        tightenRatio = 0.12
    } = options;
    const baseSize = Math.max(rect.width, rect.height);
    const pad = Math.max(3, Math.round(baseSize * padRatio));
    const expanded = clampRect({
        x: rect.x - pad,
        y: rect.y - pad,
        width: rect.width + pad * 2,
        height: rect.height + pad * 2
    }, width, height);
    const shrinkX = Math.round(expanded.width * tightenRatio);
    const shrinkY = Math.round(expanded.height * tightenRatio);
    const tightened = clampRect({
        x: expanded.x + shrinkX / 2,
        y: expanded.y + shrinkY / 2,
        width: Math.max(minSize, expanded.width - shrinkX),
        height: Math.max(minSize, expanded.height - shrinkY)
    }, width, height);
    const centerX = tightened.x + tightened.width / 2;
    const centerY = tightened.y + tightened.height / 2;
    const widthCap = Math.max(minSize, Math.round(width * maxWidthRatio));
    const heightCap = Math.max(minSize, Math.round(height * maxHeightRatio));
    const finalWidth = Math.min(tightened.width, widthCap);
    const finalHeight = Math.min(tightened.height, heightCap);

    return {
        ...clampRect({
            x: centerX - finalWidth / 2,
            y: centerY - finalHeight / 2,
            width: finalWidth,
            height: finalHeight
        }, width, height),
        shape: "ellipse"
    };
};

const normalizeAutoRegions = (rects, width, height) => rects.map((rect) => createEllipseRegion(rect, width, height));

const buildDefaultGeminiRegion = (width, height) => {
    const padding = Math.max(10, Math.round(Math.min(width, height) * 0.018));
    const diameter = clamp(
        Math.round(Math.min(width, height) * 0.09),
        34,
        Math.max(40, Math.round(Math.min(width, height) * 0.12))
    );

    return {
        ...clampRect({
            x: width - diameter - padding,
            y: height - diameter - padding,
            width: diameter,
            height: diameter
        }, width, height),
        shape: "ellipse"
    };
};

const waitForCvRuntime = () => new Promise((resolve, reject) => {
    let settled = false;
    let pollId = 0;
    let timeoutId = 0;

    const finish = (error, cvInstance = self.cv) => {
        if (settled) return;
        settled = true;
        self.clearInterval(pollId);
        self.clearTimeout(timeoutId);
        if (error) {
            reject(error);
            return;
        }
        resolve(cvInstance);
    };

    const bindCvReady = () => {
        if (!self.cv) {
            return false;
        }

        if (typeof self.cv.getBuildInformation === "function") {
            finish(null, self.cv);
            return true;
        }

        if (self.cv.ready && typeof self.cv.ready.then === "function") {
            self.cv.ready.then((cvInstance) => {
                if (cvInstance) {
                    self.cv = cvInstance;
                }
                finish(null, self.cv);
            }).catch(() => {
                finish(new Error("OpenCV.js failed to initialize."));
            });
            return true;
        }

        if (typeof self.cv.then === "function") {
            try {
                const maybeThenable = self.cv.then((cvInstance) => {
                    if (cvInstance) {
                        self.cv = cvInstance;
                    }
                    finish(null, self.cv);
                });

                if (maybeThenable && typeof maybeThenable.catch === "function") {
                    maybeThenable.catch(() => {
                        finish(new Error("OpenCV.js failed to initialize."));
                    });
                }
            } catch (error) {
                finish(error instanceof Error ? error : new Error("OpenCV.js failed to initialize."));
            }
            return true;
        }

        return false;
    };

    if (bindCvReady()) {
        return;
    }

    pollId = self.setInterval(() => {
        bindCvReady();
    }, 100);

    timeoutId = self.setTimeout(() => {
        finish(new Error("OpenCV.js took too long to initialize."));
    }, OPENCV_READY_TIMEOUT_MS);
});

const ensureCvReady = () => {
    if (cvLoadPromise) {
        return cvLoadPromise;
    }

    cvLoadPromise = (async () => {
        try {
            if (!self.cv) {
                self.importScripts(OPENCV_SCRIPT_URL);
            }
            return await waitForCvRuntime();
        } finally {
            if (!self.cv || typeof self.cv.getBuildInformation !== "function") {
                cvLoadPromise = null;
            }
        }
    })();

    return cvLoadPromise;
};

const detectWatermarkCandidates = (sourceImageData) => {
    const cv = self.cv;
    const CC_STAT_LEFT = typeof cv.CC_STAT_LEFT === "number" ? cv.CC_STAT_LEFT : 0;
    const CC_STAT_TOP = typeof cv.CC_STAT_TOP === "number" ? cv.CC_STAT_TOP : 1;
    const CC_STAT_WIDTH = typeof cv.CC_STAT_WIDTH === "number" ? cv.CC_STAT_WIDTH : 2;
    const CC_STAT_HEIGHT = typeof cv.CC_STAT_HEIGHT === "number" ? cv.CC_STAT_HEIGHT : 3;
    const CC_STAT_AREA = typeof cv.CC_STAT_AREA === "number" ? cv.CC_STAT_AREA : 4;

    const src = cv.matFromImageData(sourceImageData);
    const roiX = Math.floor(src.cols * 0.63);
    const roiY = Math.floor(src.rows * 0.63);
    const roiWidth = Math.max(32, src.cols - roiX);
    const roiHeight = Math.max(32, src.rows - roiY);
    const roiRect = new cv.Rect(roiX, roiY, roiWidth, roiHeight);
    const roi = src.roi(roiRect);
    const gray = new cv.Mat();
    const binary = new cv.Mat();
    const labels = new cv.Mat();
    const stats = new cv.Mat();
    const centroids = new cv.Mat();
    const morphKernel = cv.Mat.ones(3, 3, cv.CV_8U);

    try {
        cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
        cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        cv.dilate(binary, binary, morphKernel);
        cv.erode(binary, binary, morphKernel);
        cv.erode(binary, binary, morphKernel);
        cv.dilate(binary, binary, morphKernel);
        cv.connectedComponentsWithStats(binary, labels, stats, centroids, 8, cv.CV_32S);

        const roiArea = roiWidth * roiHeight;
        const candidates = [];

        for (let row = 1; row < stats.rows; row += 1) {
            const offset = row * stats.cols;
            const left = stats.data32S[offset + CC_STAT_LEFT];
            const top = stats.data32S[offset + CC_STAT_TOP];
            const width = stats.data32S[offset + CC_STAT_WIDTH];
            const height = stats.data32S[offset + CC_STAT_HEIGHT];
            const area = stats.data32S[offset + CC_STAT_AREA];
            const right = left + width;
            const bottom = top + height;
            const density = area / Math.max(1, width * height);

            if (area < Math.max(18, Math.round(roiArea * 0.0002))) continue;
            if (area > roiArea * 0.03) continue;
            if (width < 5 || height < 5) continue;
            if (width > roiWidth * 0.36 || height > roiHeight * 0.28) continue;
            if (density < 0.1 || density > 0.92) continue;
            if (right < roiWidth * 0.48 || bottom < roiHeight * 0.48) continue;

            const pad = Math.max(3, Math.round(Math.max(width, height) * 0.16));
            candidates.push(clampRect({
                x: roiRect.x + left - pad,
                y: roiRect.y + top - pad,
                width: width + pad * 2,
                height: height + pad * 2
            }, src.cols, src.rows));
        }

        const rects = normalizeAutoRegions(
            mergeRects(candidates, Math.max(4, Math.round(Math.max(src.cols, src.rows) * 0.004))).slice(0, 4),
            src.cols,
            src.rows
        );
        if (rects.length) {
            return { rects, mode: "detected" };
        }

        return { rects: [buildDefaultGeminiRegion(src.cols, src.rows)], mode: "default" };
    } finally {
        safeDelete(roi, gray, binary, labels, stats, centroids, morphKernel, src);
    }
};

const inpaintImage = ({ sourceBuffer, maskBuffer, width, height }) => {
    const cv = self.cv;
    const sourceImageData = new ImageData(new Uint8ClampedArray(sourceBuffer), width, height);
    const maskImageData = new ImageData(new Uint8ClampedArray(maskBuffer), width, height);
    const srcRgba = cv.matFromImageData(sourceImageData);
    const srcRgb = new cv.Mat();
    const maskRgba = cv.matFromImageData(maskImageData);
    const maskGray = new cv.Mat();
    const maskBinary = new cv.Mat();
    const resultRgb = new cv.Mat();
    const resultRgba = new cv.Mat();

    try {
        cv.cvtColor(srcRgba, srcRgb, cv.COLOR_RGBA2RGB);
        cv.cvtColor(maskRgba, maskGray, cv.COLOR_RGBA2GRAY);
        cv.threshold(maskGray, maskBinary, 1, 255, cv.THRESH_BINARY);
        cv.inpaint(srcRgb, maskBinary, resultRgb, 3, cv.INPAINT_TELEA);
        cv.cvtColor(resultRgb, resultRgba, cv.COLOR_RGB2RGBA);
        return new Uint8ClampedArray(resultRgba.data);
    } finally {
        safeDelete(srcRgba, srcRgb, maskRgba, maskGray, maskBinary, resultRgb, resultRgba);
    }
};

self.onmessage = async (event) => {
    const { id, type, payload } = event.data || {};

    try {
        await ensureCvReady();

        if (type === "ensureReady") {
            self.postMessage({ id, type: "ready" });
            return;
        }

        if (type === "detect") {
            const imageData = new ImageData(new Uint8ClampedArray(payload.sourceBuffer), payload.width, payload.height);
            const detection = detectWatermarkCandidates(imageData);
            self.postMessage({ id, type: "detectResult", rects: detection.rects, mode: detection.mode });
            return;
        }

        if (type === "inpaint") {
            const output = inpaintImage(payload);
            self.postMessage({
                id,
                type: "inpaintResult",
                width: payload.width,
                height: payload.height,
                resultBuffer: output.buffer
            }, [output.buffer]);
            return;
        }

        throw new Error("Unknown OpenCV worker request.");
    } catch (error) {
        self.postMessage({
            id,
            type: "error",
            message: error instanceof Error ? error.message : "OpenCV worker request failed."
        });
    }
};
`;

    const getCvWorker = () => {
        if (cvWorkerState.worker) {
            return cvWorkerState.worker;
        }

        const workerBlob = new Blob([createOpenCvWorkerSource()], { type: "text/javascript" });
        cvWorkerState.workerUrl = URL.createObjectURL(workerBlob);
        cvWorkerState.worker = new Worker(cvWorkerState.workerUrl);

        cvWorkerState.worker.addEventListener("message", (event) => {
            const payload = event.data || {};
            const pendingRequest = cvWorkerState.pending.get(payload.id);
            if (!pendingRequest) {
                return;
            }

            cvWorkerState.pending.delete(payload.id);
            if (payload.type === "error") {
                pendingRequest.reject(new Error(payload.message || "OpenCV worker request failed."));
                return;
            }

            pendingRequest.resolve(payload);
        });

        cvWorkerState.worker.addEventListener("error", () => {
            failPendingCvRequests("OpenCV worker crashed.");
            if (cvWorkerState.worker) {
                cvWorkerState.worker.terminate();
            }
            cvWorkerState.worker = null;
        });

        return cvWorkerState.worker;
    };

    const requestCvWorker = (type, payload, transfer = []) => new Promise((resolve, reject) => {
        const requestId = cvWorkerState.nextRequestId + 1;
        cvWorkerState.nextRequestId = requestId;
        cvWorkerState.pending.set(requestId, { resolve, reject });
        getCvWorker().postMessage({ id: requestId, type, payload }, transfer);
    });

    const openFilePicker = () => {
        UI.fileInput.value = "";
        try {
            if (typeof UI.fileInput.showPicker === "function") {
                UI.fileInput.showPicker();
                return;
            }
        } catch (error) {
            // Fall back to click() for browsers that gate showPicker().
        }
        UI.fileInput.click();
    };

    const getEffectiveMimeType = (file) => {
        if (file?.type) {
            return file.type.toLowerCase();
        }

        const extensionMatch = file?.name?.match(/\.[^.]+$/);
        if (!extensionMatch) {
            return "";
        }

        return EXTENSION_TO_MIME.get(extensionMatch[0].toLowerCase()) || "";
    };

    const getFirstTransferredFile = (dataTransfer) => {
        if (!dataTransfer) return null;

        if (dataTransfer.items?.length) {
            for (const item of dataTransfer.items) {
                if (item.kind !== "file") continue;
                const file = item.getAsFile();
                if (file) return file;
            }
        }

        return dataTransfer.files?.[0] || null;
    };

    const clearProcessedResult = () => {
        revokeObjectUrl(state.processedUrl);
        state.processedBlob = null;
        state.processedUrl = "";
        state.comparisonRatio = 0.5;
        UI.imgAfter.removeAttribute("src");
        UI.imgBeforeWrapper.style.width = "50%";
        UI.sliderHandle.style.left = "50%";
        updateControls();
    };

    const resetEditorState = () => {
        state.manualStrokes = [];
        state.activeStroke = null;
        state.activePointerId = null;
        state.autoRects = [];
        UI.autoDetectToggle.checked = false;
        updateMaskIndicators();
    };

    const resetCanvases = () => {
        contexts.preview.clearRect(0, 0, UI.imgCanvas.width, UI.imgCanvas.height);
        contexts.previewMask.clearRect(0, 0, UI.maskCanvas.width, UI.maskCanvas.height);
        contexts.source.clearRect(0, 0, buffers.sourceCanvas.width, buffers.sourceCanvas.height);
        contexts.fullMask.clearRect(0, 0, buffers.fullMaskCanvas.width, buffers.fullMaskCanvas.height);
        contexts.result.clearRect(0, 0, buffers.resultCanvas.width, buffers.resultCanvas.height);
        buffers.resultCanvas.width = 0;
        buffers.resultCanvas.height = 0;
        UI.canvasWrapper.style.width = "";
        UI.canvasWrapper.style.height = "";
    };

    const fitPreviewCanvas = () => {
        if (!state.originalImage) return;

        const maxWidth = Math.max(200, UI.canvasArea.clientWidth - 32);
        const maxHeight = Math.max(240, Math.min(window.innerHeight - 360, 720));
        const scale = Math.min(1, maxWidth / state.originalWidth, maxHeight / state.originalHeight);

        state.previewScale = Number.isFinite(scale) ? scale : 1;
        state.previewWidth = Math.max(1, Math.round(state.originalWidth * state.previewScale));
        state.previewHeight = Math.max(1, Math.round(state.originalHeight * state.previewScale));

        UI.imgCanvas.width = state.previewWidth;
        UI.imgCanvas.height = state.previewHeight;
        UI.maskCanvas.width = state.previewWidth;
        UI.maskCanvas.height = state.previewHeight;
        UI.canvasWrapper.style.width = `${state.previewWidth}px`;
        UI.canvasWrapper.style.height = `${state.previewHeight}px`;
    };

    const drawPreviewImage = () => {
        contexts.preview.clearRect(0, 0, UI.imgCanvas.width, UI.imgCanvas.height);
        contexts.preview.drawImage(buffers.sourceCanvas, 0, 0, state.previewWidth, state.previewHeight);
    };

    const drawRects = (ctx, rects, scale, fillStyle, strokeStyle) => {
        rects.forEach((rect) => {
            const x = rect.x * scale;
            const y = rect.y * scale;
            const width = rect.width * scale;
            const height = rect.height * scale;
            const isEllipse = rect.shape === "ellipse";

            if (fillStyle) {
                ctx.fillStyle = fillStyle;
                if (isEllipse) {
                    ctx.beginPath();
                    ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
                    ctx.fill();
                } else {
                    ctx.fillRect(x, y, width, height);
                }
            }

            if (strokeStyle) {
                ctx.strokeStyle = strokeStyle;
                ctx.lineWidth = Math.max(1, scale * 1.5);
                if (isEllipse) {
                    ctx.beginPath();
                    ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
                    ctx.stroke();
                } else {
                    ctx.strokeRect(x, y, width, height);
                }
            }
        });
    };

    const drawStrokeList = (ctx, strokes, scale, strokeStyle, fillStyle) => {
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.strokeStyle = strokeStyle;
        ctx.fillStyle = fillStyle;

        strokes.forEach((stroke) => {
            const firstPoint = stroke.points[0];
            if (!firstPoint) return;

            const scaledWidth = Math.max(1, stroke.width * scale);
            if (stroke.points.length === 1) {
                ctx.beginPath();
                ctx.arc(firstPoint.x * scale, firstPoint.y * scale, scaledWidth / 2, 0, Math.PI * 2);
                ctx.fill();
                return;
            }

            ctx.beginPath();
            ctx.moveTo(firstPoint.x * scale, firstPoint.y * scale);
            stroke.points.slice(1).forEach((point) => {
                ctx.lineTo(point.x * scale, point.y * scale);
            });
            ctx.lineWidth = scaledWidth;
            ctx.stroke();
        });
    };

    const renderMasks = () => {
        if (!state.originalImage) {
            resetCanvases();
            updateMaskIndicators();
            updateControls();
            return;
        }

        drawPreviewImage();
        contexts.previewMask.clearRect(0, 0, UI.maskCanvas.width, UI.maskCanvas.height);
        contexts.fullMask.clearRect(0, 0, buffers.fullMaskCanvas.width, buffers.fullMaskCanvas.height);

        const allManualStrokes = state.activeStroke
            ? [...state.manualStrokes, state.activeStroke]
            : [...state.manualStrokes];

        drawRects(contexts.previewMask, state.autoRects, state.previewScale, AUTO_FILL_COLOR, AUTO_STROKE_COLOR);
        drawStrokeList(contexts.previewMask, allManualStrokes, state.previewScale, MANUAL_PREVIEW_COLOR, MANUAL_PREVIEW_COLOR);

        drawRects(contexts.fullMask, state.autoRects, 1, "#ffffff", null);
        drawStrokeList(contexts.fullMask, allManualStrokes, 1, "#ffffff", "#ffffff");

        updateMaskIndicators();
        updateControls();
    };

    const clampRect = (rect, width, height) => {
        const x = clamp(Math.round(rect.x), 0, width);
        const y = clamp(Math.round(rect.y), 0, height);
        const maxWidth = Math.max(0, width - x);
        const maxHeight = Math.max(0, height - y);

        return {
            x,
            y,
            width: clamp(Math.round(rect.width), 0, maxWidth),
            height: clamp(Math.round(rect.height), 0, maxHeight)
        };
    };

    const shouldMergeRects = (first, second, gap) => !(
        first.x + first.width + gap < second.x ||
        second.x + second.width + gap < first.x ||
        first.y + first.height + gap < second.y ||
        second.y + second.height + gap < first.y
    );

    const mergeRects = (rects, gap) => {
        const pending = [...rects];
        const merged = [];

        while (pending.length) {
            let current = pending.pop();
            let mergedAny = true;

            while (mergedAny) {
                mergedAny = false;
                for (let index = pending.length - 1; index >= 0; index -= 1) {
                    if (!shouldMergeRects(current, pending[index], gap)) {
                        continue;
                    }

                    const candidate = pending[index];
                    const minX = Math.min(current.x, candidate.x);
                    const minY = Math.min(current.y, candidate.y);
                    const maxX = Math.max(current.x + current.width, candidate.x + candidate.width);
                    const maxY = Math.max(current.y + current.height, candidate.y + candidate.height);

                    current = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
                    pending.splice(index, 1);
                    mergedAny = true;
                }
            }

            merged.push(current);
        }

        return merged.sort((left, right) => {
            const leftScore = left.x + left.width + left.y + left.height;
            const rightScore = right.x + right.width + right.y + right.height;
            return rightScore - leftScore;
        });
    };

    const createEllipseRegion = (rect, width, height, options = {}) => {
        const {
            padRatio = 0.16,
            minSize = 24,
            maxWidthRatio = 0.16,
            maxHeightRatio = 0.14,
            tightenRatio = 0.12
        } = options;
        const baseSize = Math.max(rect.width, rect.height);
        const pad = Math.max(3, Math.round(baseSize * padRatio));
        const expanded = clampRect({
            x: rect.x - pad,
            y: rect.y - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2
        }, width, height);
        const shrinkX = Math.round(expanded.width * tightenRatio);
        const shrinkY = Math.round(expanded.height * tightenRatio);
        const tightened = clampRect({
            x: expanded.x + shrinkX / 2,
            y: expanded.y + shrinkY / 2,
            width: Math.max(minSize, expanded.width - shrinkX),
            height: Math.max(minSize, expanded.height - shrinkY)
        }, width, height);
        const centerX = tightened.x + tightened.width / 2;
        const centerY = tightened.y + tightened.height / 2;
        const widthCap = Math.max(minSize, Math.round(width * maxWidthRatio));
        const heightCap = Math.max(minSize, Math.round(height * maxHeightRatio));
        const finalWidth = Math.min(tightened.width, widthCap);
        const finalHeight = Math.min(tightened.height, heightCap);

        return {
            ...clampRect({
                x: centerX - finalWidth / 2,
                y: centerY - finalHeight / 2,
                width: finalWidth,
                height: finalHeight
            }, width, height),
            shape: "ellipse"
        };
    };

    const normalizeAutoRegions = (rects, width, height) => rects.map((rect) => createEllipseRegion(rect, width, height));

    const buildDefaultGeminiRegion = (width, height) => {
        const padding = Math.max(10, Math.round(Math.min(width, height) * 0.018));
        const diameter = clamp(
            Math.round(Math.min(width, height) * 0.09),
            34,
            Math.max(40, Math.round(Math.min(width, height) * 0.12))
        );

        return {
            ...clampRect({
                x: width - diameter - padding,
                y: height - diameter - padding,
                width: diameter,
                height: diameter
            }, width, height),
            shape: "ellipse"
        };
    };

    const detectWatermarkCandidatesFallback = (sourceImageData) => {
        const { data, width, height } = sourceImageData;
        const roiX = Math.floor(width * 0.62);
        const roiY = Math.floor(height * 0.62);
        const roiWidth = Math.max(32, width - roiX);
        const roiHeight = Math.max(32, height - roiY);
        const pixelCount = roiWidth * roiHeight;
        const visited = new Uint8Array(pixelCount);
        const binary = new Uint8Array(roiWidth * roiHeight);
        const luminanceMap = new Float32Array(pixelCount);
        const saturationMap = new Uint8Array(pixelCount);
        const edgeMap = new Float32Array(pixelCount);
        const integralLuminance = new Float64Array((roiWidth + 1) * (roiHeight + 1));

        for (let y = 0; y < roiHeight; y += 1) {
            let rowSum = 0;

            for (let x = 0; x < roiWidth; x += 1) {
                const sourceX = roiX + x;
                const sourceY = roiY + y;
                const index = (sourceY * width + sourceX) * 4;
                const red = data[index];
                const green = data[index + 1];
                const blue = data[index + 2];
                const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
                const saturation = Math.max(red, green, blue) - Math.min(red, green, blue);
                const roiIndex = y * roiWidth + x;

                luminanceMap[roiIndex] = luminance;
                saturationMap[roiIndex] = saturation;
                rowSum += luminance;
                integralLuminance[(y + 1) * (roiWidth + 1) + (x + 1)] = integralLuminance[y * (roiWidth + 1) + (x + 1)] + rowSum;
            }
        }

        let edgeAverage = 0;

        for (let y = 0; y < roiHeight; y += 1) {
            for (let x = 0; x < roiWidth; x += 1) {
                const roiIndex = y * roiWidth + x;
                const luminance = luminanceMap[roiIndex];
                const rightLuminance = x + 1 < roiWidth ? luminanceMap[roiIndex + 1] : luminance;
                const downLuminance = y + 1 < roiHeight ? luminanceMap[roiIndex + roiWidth] : luminance;
                const edgeScore = Math.abs(luminance - rightLuminance) + Math.abs(luminance - downLuminance);
                edgeMap[roiIndex] = edgeScore;
                edgeAverage += edgeScore;
            }
        }

        edgeAverage /= Math.max(1, pixelCount);
        const localRadius = Math.max(6, Math.round(Math.max(roiWidth, roiHeight) * 0.025));
        const edgeThreshold = Math.max(10, edgeAverage * 1.2);
        const contrastThreshold = Math.max(8, edgeAverage * 0.72);

        for (let y = 0; y < roiHeight; y += 1) {
            for (let x = 0; x < roiWidth; x += 1) {
                const roiIndex = y * roiWidth + x;
                const luminance = luminanceMap[roiIndex];
                const saturation = saturationMap[roiIndex];
                const left = Math.max(0, x - localRadius);
                const top = Math.max(0, y - localRadius);
                const right = Math.min(roiWidth - 1, x + localRadius);
                const bottom = Math.min(roiHeight - 1, y + localRadius);
                const sum = integralLuminance[(bottom + 1) * (roiWidth + 1) + (right + 1)]
                    - integralLuminance[top * (roiWidth + 1) + (right + 1)]
                    - integralLuminance[(bottom + 1) * (roiWidth + 1) + left]
                    + integralLuminance[top * (roiWidth + 1) + left];
                const area = (right - left + 1) * (bottom - top + 1);
                const localMean = sum / Math.max(1, area);
                const contrast = luminance - localMean;
                const edgeScore = edgeMap[roiIndex];
                const isNearBottomRight = x > roiWidth * 0.4 && y > roiHeight * 0.38;

                const lowSaturation = saturation < 72;
                const veryLowSaturation = saturation < 42;
                const brightContrast = contrast > contrastThreshold * 1.1;
                const darkContrast = contrast < -contrastThreshold * 1.1;
                const edgeCandidate = edgeScore > edgeThreshold * 1.1 && Math.abs(contrast) > contrastThreshold * 0.52;
                const watermarkCandidate = isNearBottomRight && (
                    (veryLowSaturation && (brightContrast || darkContrast))
                    || (lowSaturation && edgeCandidate)
                    || (edgeScore > edgeThreshold * 1.7 && saturation < 92)
                );

                if (watermarkCandidate) {
                    binary[roiIndex] = 1;
                }
            }
        }

        const expanded = new Uint8Array(binary.length);
        for (let y = 0; y < roiHeight; y += 1) {
            for (let x = 0; x < roiWidth; x += 1) {
                const roiIndex = y * roiWidth + x;
                if (!binary[roiIndex]) continue;

                for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
                    const nextY = y + offsetY;
                    if (nextY < 0 || nextY >= roiHeight) continue;
                    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
                        const nextX = x + offsetX;
                        if (nextX < 0 || nextX >= roiWidth) continue;
                        expanded[nextY * roiWidth + nextX] = 1;
                    }
                }
            }
        }

        const refined = new Uint8Array(expanded.length);
        for (let y = 0; y < roiHeight; y += 1) {
            for (let x = 0; x < roiWidth; x += 1) {
                let neighbors = 0;
                for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
                    const nextY = y + offsetY;
                    if (nextY < 0 || nextY >= roiHeight) continue;
                    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
                        const nextX = x + offsetX;
                        if (nextX < 0 || nextX >= roiWidth) continue;
                        neighbors += expanded[nextY * roiWidth + nextX];
                    }
                }

                if (neighbors >= 3) {
                    refined[y * roiWidth + x] = 1;
                }
            }
        }

        const candidates = [];
        const queueX = [];
        const queueY = [];

        for (let y = 0; y < roiHeight; y += 1) {
            for (let x = 0; x < roiWidth; x += 1) {
                const seed = y * roiWidth + x;
                if (!refined[seed] || visited[seed]) {
                    continue;
                }

                let area = 0;
                let minX = x;
                let minY = y;
                let maxX = x;
                let maxY = y;
                queueX.length = 0;
                queueY.length = 0;
                queueX.push(x);
                queueY.push(y);
                visited[seed] = 1;

                while (queueX.length) {
                    const currentX = queueX.pop();
                    const currentY = queueY.pop();
                    area += 1;
                    minX = Math.min(minX, currentX);
                    minY = Math.min(minY, currentY);
                    maxX = Math.max(maxX, currentX);
                    maxY = Math.max(maxY, currentY);

                    const neighbors = [
                        [currentX - 1, currentY],
                        [currentX + 1, currentY],
                        [currentX, currentY - 1],
                        [currentX, currentY + 1]
                    ];

                    neighbors.forEach(([nextX, nextY]) => {
                        if (nextX < 0 || nextY < 0 || nextX >= roiWidth || nextY >= roiHeight) {
                            return;
                        }

                        const neighborIndex = nextY * roiWidth + nextX;
                        if (!refined[neighborIndex] || visited[neighborIndex]) {
                            return;
                        }

                        visited[neighborIndex] = 1;
                        queueX.push(nextX);
                        queueY.push(nextY);
                    });
                }

                const componentWidth = maxX - minX + 1;
                const componentHeight = maxY - minY + 1;
                const density = area / Math.max(1, componentWidth * componentHeight);
                if (area < Math.max(10, Math.round(roiWidth * roiHeight * 0.00008))) continue;
                if (area > roiWidth * roiHeight * 0.035) continue;
                if (componentWidth < 4 || componentHeight < 4) continue;
                if (componentWidth > roiWidth * 0.34 || componentHeight > roiHeight * 0.28) continue;
                if (density < 0.08 || density > 0.95) continue;
                if (maxX < roiWidth * 0.34 || maxY < roiHeight * 0.34) continue;

                const pad = Math.max(3, Math.round(Math.max(componentWidth, componentHeight) * 0.16));
                candidates.push(clampRect({
                    x: roiX + minX - pad,
                    y: roiY + minY - pad,
                    width: componentWidth + pad * 2,
                    height: componentHeight + pad * 2
                }, width, height));
            }
        }

        const rects = normalizeAutoRegions(
            mergeRects(candidates, Math.max(4, Math.round(Math.max(width, height) * 0.004))).slice(0, 4),
            width,
            height
        );
        if (rects.length) {
            return { rects, mode: "detected" };
        }

        return { rects: [buildDefaultGeminiRegion(width, height)], mode: "default" };
    };

    const inpaintImageFallback = (sourceImageData, maskImageData) => {
        const { data: sourceData, width, height } = sourceImageData;
        const maskData = maskImageData.data;
        const resultData = new Uint8ClampedArray(sourceData);
        const masked = new Uint8Array(width * height);
        const frontier = [];
        const queued = new Uint8Array(width * height);

        const pushFrontier = (index) => {
            if (!masked[index] || queued[index]) {
                return;
            }
            queued[index] = 1;
            frontier.push(index);
        };

        const getNeighbors = (index, radius) => {
            const x = index % width;
            const y = Math.floor(index / width);
            const samples = [];

            for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
                const nextY = y + offsetY;
                if (nextY < 0 || nextY >= height) continue;

                for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
                    const nextX = x + offsetX;
                    if (nextX < 0 || nextX >= width) continue;
                    if (offsetX === 0 && offsetY === 0) continue;

                    const neighborIndex = nextY * width + nextX;
                    if (masked[neighborIndex]) continue;
                    samples.push({ neighborIndex, distance: Math.hypot(offsetX, offsetY) || 1 });
                }
            }

            return samples;
        };

        for (let index = 0; index < masked.length; index += 1) {
            const alpha = maskData[index * 4 + 3];
            const red = maskData[index * 4];
            masked[index] = alpha > 0 || red > 0 ? 1 : 0;
        }

        for (let index = 0; index < masked.length; index += 1) {
            if (!masked[index]) continue;
            if (getNeighbors(index, 1).length) {
                pushFrontier(index);
            }
        }

        let radius = 1;
        let guard = 0;

        while (frontier.length && guard < masked.length * 2) {
            guard += 1;
            const currentIndex = frontier.shift();
            queued[currentIndex] = 0;
            if (!masked[currentIndex]) continue;

            const samples = getNeighbors(currentIndex, radius);
            if (samples.length < 2) {
                pushFrontier(currentIndex);
                if (frontier.length === 1) {
                    radius = Math.min(radius + 1, 10);
                }
                continue;
            }

            let totalWeight = 0;
            let red = 0;
            let green = 0;
            let blue = 0;
            let alpha = 0;

            samples.forEach(({ neighborIndex, distance }) => {
                const weight = 1 / distance;
                const offset = neighborIndex * 4;
                totalWeight += weight;
                red += resultData[offset] * weight;
                green += resultData[offset + 1] * weight;
                blue += resultData[offset + 2] * weight;
                alpha += resultData[offset + 3] * weight;
            });

            const resultOffset = currentIndex * 4;
            resultData[resultOffset] = Math.round(red / totalWeight);
            resultData[resultOffset + 1] = Math.round(green / totalWeight);
            resultData[resultOffset + 2] = Math.round(blue / totalWeight);
            resultData[resultOffset + 3] = Math.round(alpha / totalWeight);
            masked[currentIndex] = 0;
            radius = 1;

            const x = currentIndex % width;
            const y = Math.floor(currentIndex / width);
            [
                [x - 1, y],
                [x + 1, y],
                [x, y - 1],
                [x, y + 1],
                [x - 1, y - 1],
                [x + 1, y - 1],
                [x - 1, y + 1],
                [x + 1, y + 1]
            ].forEach(([nextX, nextY]) => {
                if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
                    return;
                }
                pushFrontier(nextY * width + nextX);
            });
        }

        for (let index = 0; index < masked.length; index += 1) {
            if (!masked[index]) continue;

            const fallbackSamples = getNeighbors(index, 10);
            if (!fallbackSamples.length) continue;
            const nearest = fallbackSamples[0].neighborIndex * 4;
            const offset = index * 4;
            resultData[offset] = resultData[nearest];
            resultData[offset + 1] = resultData[nearest + 1];
            resultData[offset + 2] = resultData[nearest + 2];
            resultData[offset + 3] = resultData[nearest + 3];
        }

        return new ImageData(resultData, width, height);
    };

    const getPreviewPoint = (event) => {
        const rect = UI.maskCanvas.getBoundingClientRect();
        const scaleX = UI.maskCanvas.width / rect.width;
        const scaleY = UI.maskCanvas.height / rect.height;
        return {
            x: (event.clientX - rect.left) * scaleX,
            y: (event.clientY - rect.top) * scaleY
        };
    };

    const getSourcePoint = (event) => {
        const previewPoint = getPreviewPoint(event);
        return {
            x: clamp(previewPoint.x / state.previewScale, 0, state.originalWidth),
            y: clamp(previewPoint.y / state.previewScale, 0, state.originalHeight)
        };
    };

    const getBrushWidthInSourcePixels = () => {
        const previewWidth = Number.parseInt(UI.brushSizeInput.value, 10);
        return Math.max(1, previewWidth / Math.max(state.previewScale, 0.001));
    };

    const invalidateProcessedOutput = () => {
        if (state.processedBlob || state.processedUrl) {
            clearProcessedResult();
        }
    };

    const onMaskPointerDown = (event) => {
        if (!state.originalImage || isBusy()) return;
        if (event.pointerType === "mouse" && event.button !== 0) return;

        event.preventDefault();
        invalidateProcessedOutput();
        state.activePointerId = event.pointerId;
        state.activeStroke = {
            width: getBrushWidthInSourcePixels(),
            points: [getSourcePoint(event)]
        };
        UI.maskCanvas.setPointerCapture(event.pointerId);
        renderMasks();
    };

    const onMaskPointerMove = (event) => {
        if (!state.activeStroke || event.pointerId !== state.activePointerId) return;

        event.preventDefault();
        const point = getSourcePoint(event);
        const lastPoint = state.activeStroke.points[state.activeStroke.points.length - 1];
        if (Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y) < 0.5) return;

        state.activeStroke.points.push(point);
        renderMasks();
    };

    const finishStroke = (event) => {
        if (!state.activeStroke) return;
        if (event && event.pointerId !== state.activePointerId) return;

        if (state.activeStroke.points.length) {
            state.manualStrokes.push(state.activeStroke);
            setEditorStatus("Manual mask updated. Continue painting or run erase when ready.", "ready");
        }

        state.activeStroke = null;
        state.activePointerId = null;
        renderMasks();
    };

    const setComparisonRatio = (ratio) => {
        state.comparisonRatio = clamp(ratio, 0, 1);
        const sliderRect = UI.comparisonSlider.getBoundingClientRect();
        const width = sliderRect.width * state.comparisonRatio;
        UI.imgBeforeWrapper.style.width = `${width}px`;
        UI.sliderHandle.style.left = `${width}px`;
    };

    const syncComparisonLayout = () => {
        if (!state.originalWidth || !state.originalHeight) return;

        UI.comparisonSlider.style.aspectRatio = `${state.originalWidth} / ${state.originalHeight}`;
        const sliderRect = UI.comparisonSlider.getBoundingClientRect();
        if (!sliderRect.width || !sliderRect.height) return;

        UI.imgBefore.style.width = `${sliderRect.width}px`;
        UI.imgBefore.style.height = `${sliderRect.height}px`;
        setComparisonRatio(state.comparisonRatio);
    };

    const updateComparisonFromClientX = (clientX) => {
        const rect = UI.comparisonSlider.getBoundingClientRect();
        if (!rect.width) return;
        const offsetX = clamp(clientX - rect.left, 0, rect.width);
        setComparisonRatio(offsetX / rect.width);
    };

    const initializeComparisonSlider = () => {
        UI.comparisonSlider.addEventListener("pointerdown", (event) => {
            if (!UI.zones.result.classList.contains("active")) return;
            event.preventDefault();
            UI.comparisonSlider.setPointerCapture(event.pointerId);
            updateComparisonFromClientX(event.clientX);
        });

        UI.comparisonSlider.addEventListener("pointermove", (event) => {
            if (!UI.zones.result.classList.contains("active")) return;
            if (event.pressure === 0 && event.buttons === 0 && event.pointerType !== "touch") return;
            updateComparisonFromClientX(event.clientX);
        });
    };

    const updateEditorForCurrentImage = () => {
        fitPreviewCanvas();
        renderMasks();
        updateResolutionBadges();
        syncComparisonLayout();
    };

    const clearWorkspace = () => {
        revokeObjectUrl(state.originalUrl);
        revokeObjectUrl(state.processedUrl);

        state.imageFile = null;
        state.originalUrl = "";
        state.originalImage = null;
        state.originalWidth = 0;
        state.originalHeight = 0;
        state.previewScale = 1;
        state.previewWidth = 0;
        state.previewHeight = 0;
        state.processedBlob = null;
        state.processedUrl = "";
        state.comparisonRatio = 0.5;

        resetEditorState();
        resetCanvases();
        UI.fileInput.value = "";
        UI.imgBefore.removeAttribute("src");
        UI.imgAfter.removeAttribute("src");
        updateResolutionBadges();
        switchZone("upload");

        if (state.cvReady) {
            setEditorStatus("OpenCV.js ready. Upload an image to begin.", "ready");
        } else if (state.cvError) {
            setEditorStatus(state.cvError.message, "error");
        } else {
            setEditorStatus("Choose an image to begin. Masking and erase stay local.", "neutral");
        }

        setUploadFeedback(DEFAULT_UPLOAD_MESSAGE, "neutral");
        renderMasks();
        updateControls();
    };

    const prepareImageState = async (file) => {
        const effectiveMimeType = getEffectiveMimeType(file);
        if (!SUPPORTED_TYPES.has(effectiveMimeType)) {
            throw new Error("Please choose a PNG, JPG, or WEBP image.");
        }

        revokeObjectUrl(state.originalUrl);
        revokeObjectUrl(state.processedUrl);

        state.imageFile = file;
        state.originalUrl = URL.createObjectURL(file);
        state.originalImage = await loadImageFromUrl(state.originalUrl);
        state.originalWidth = state.originalImage.naturalWidth;
        state.originalHeight = state.originalImage.naturalHeight;

        buffers.sourceCanvas.width = state.originalWidth;
        buffers.sourceCanvas.height = state.originalHeight;
        buffers.fullMaskCanvas.width = state.originalWidth;
        buffers.fullMaskCanvas.height = state.originalHeight;
        buffers.resultCanvas.width = state.originalWidth;
        buffers.resultCanvas.height = state.originalHeight;

        contexts.source.clearRect(0, 0, state.originalWidth, state.originalHeight);
        contexts.source.drawImage(state.originalImage, 0, 0, state.originalWidth, state.originalHeight);
        contexts.fullMask.clearRect(0, 0, state.originalWidth, state.originalHeight);

        state.processedBlob = null;
        state.processedUrl = "";
        state.comparisonRatio = 0.5;
        resetEditorState();
        UI.imgBefore.src = state.originalUrl;
        UI.imgAfter.removeAttribute("src");
    };

    const handleFile = async (file) => {
        if (!file) return;

        try {
            setUploadFeedback(`Loading ${file.name}...`, "neutral");
            await prepareImageState(file);
            switchZone("editor");
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    updateEditorForCurrentImage();
                });
            });

            const statusMessage = state.cvReady
                ? "Paint the watermark or use auto-detect before running full-resolution erase."
                : "Image loaded. Paint the watermark or use auto-detect, then run local erase.";

            setEditorStatus(statusMessage, state.cvReady ? "ready" : "neutral");
            setUploadFeedback(`${file.name} loaded at ${state.originalWidth} × ${state.originalHeight}.`, "ready");
            if (!state.cvReady && !state.cvLoadPromise && !state.cvError) {
                void ensureOpenCvReady().catch((error) => {
                    console.error(error);
                });
            }
            updateControls();
        } catch (error) {
            console.error(error);
            const message = error.message || "Failed to load the selected image.";
            if (!state.originalImage) {
                clearWorkspace();
            }
            setUploadFeedback(message, "error");
        }
    };

    const getSourceImageData = () => contexts.source.getImageData(0, 0, state.originalWidth, state.originalHeight);

    const getFullMaskImageData = () => contexts.fullMask.getImageData(0, 0, state.originalWidth, state.originalHeight);

    const ensureOpenCvReady = async () => {
        if (state.cvReady) return true;

        if (!state.cvLoadPromise) {
            state.cvLoadPromise = (async () => {
                try {
                    await waitForNextPaint();
                    state.cvError = null;
                    await requestCvWorker("ensureReady", {});
                    state.cvReady = true;
                    if (!state.originalImage) {
                        setEditorStatus("Enhanced OpenCV tools are ready. Upload an image to begin.", "ready");
                    } else {
                        setEditorStatus("Enhanced OpenCV tools are ready. Paint the watermark or use auto-detect before erase.", "ready");
                    }
                    updateControls();
                    return true;
                } catch (error) {
                    state.cvReady = false;
                    state.cvError = error instanceof Error ? error : new Error("Failed to load OpenCV.js.");
                    setEditorStatus(state.cvError.message, "error");
                    updateControls();
                    throw state.cvError;
                } finally {
                    state.cvLoadPromise = null;
                }
            })();
        }

        return state.cvLoadPromise;
    };

    const handleAutoDetectChange = async () => {
        if (!state.originalImage) {
            UI.autoDetectToggle.checked = false;
            return;
        }

        invalidateProcessedOutput();

        if (!UI.autoDetectToggle.checked) {
            state.autoRects = [];
            renderMasks();
            const message = state.manualStrokes.length
                ? "Auto-detect suggestions removed. Manual mask kept."
                : "Auto-detect cleared. Paint the watermark manually or enable it again.";
            setEditorStatus(message, "neutral");
            return;
        }

        state.detecting = true;
        updateControls();
        setLoadingState(true, "Scanning the bottom-right corner for watermark fragments...");
        setEditorStatus(
            state.cvReady
                ? "Scanning for likely watermark fragments..."
                : "Scanning with the built-in local detector...",
            "neutral"
        );

        try {
            const sourceImage = getSourceImageData();
            let detection = { rects: [], mode: "detected" };

            if (state.cvReady) {
                const sourceBuffer = new Uint8ClampedArray(sourceImage.data).buffer;
                const response = await requestCvWorker("detect", {
                    sourceBuffer,
                    width: sourceImage.width,
                    height: sourceImage.height
                }, [sourceBuffer]);
                detection = {
                    rects: response.rects || [],
                    mode: response.mode || "detected"
                };
            } else {
                detection = detectWatermarkCandidatesFallback(sourceImage);
            }

            const candidates = detection.rects || [];
            state.autoRects = candidates;
            renderMasks();

            if (candidates.length === 0) {
                UI.autoDetectToggle.checked = false;
                setEditorStatus("Auto-detect could not find a confident candidate. Paint the watermark manually.", "error");
            } else if (detection.mode === "default") {
                setEditorStatus("Auto-detect suggested the usual bottom-right Gemini watermark zone. Adjust the mask if needed, then erase.", "ready");
            } else {
                setEditorStatus(`Auto-detect found ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}. Paint over anything it missed, then erase.`, "ready");
            }
        } catch (error) {
            console.error(error);
            UI.autoDetectToggle.checked = false;
            state.autoRects = [];
            renderMasks();
            setEditorStatus(error.message || "Auto-detect failed. Paint the watermark manually.", "error");
        } finally {
            state.detecting = false;
            setLoadingState(false);
            updateControls();
        }
    };

    const processImage = async () => {
        if (!state.originalImage) {
            setEditorStatus("Upload an image first.", "error");
            return;
        }

        if (!hasMask()) {
            setEditorStatus("Create a manual or auto mask before running erase.", "error");
            return;
        }

        try {
            state.processing = true;
            updateControls();
            setLoadingState(
                true,
                state.cvReady
                    ? "Running full-resolution TELEA inpainting locally..."
                    : "Running the built-in local fill engine..."
            );
            setEditorStatus(
                state.cvReady
                    ? "Running full-resolution local inpainting..."
                    : "Running the built-in local fill engine...",
                "neutral"
            );
            const sourceImage = getSourceImageData();
            const maskImage = getFullMaskImageData();
            let resultImageData;

            if (state.cvReady) {
                const sourceBuffer = new Uint8ClampedArray(sourceImage.data).buffer;
                const maskBuffer = new Uint8ClampedArray(maskImage.data).buffer;
                const response = await requestCvWorker("inpaint", {
                    sourceBuffer,
                    maskBuffer,
                    width: state.originalWidth,
                    height: state.originalHeight
                }, [sourceBuffer, maskBuffer]);
                resultImageData = new ImageData(
                    new Uint8ClampedArray(response.resultBuffer),
                    response.width,
                    response.height
                );
            } else {
                resultImageData = inpaintImageFallback(sourceImage, maskImage);
            }

            contexts.result.putImageData(resultImageData, 0, 0);

            const processedBlob = await canvasToBlob(buffers.resultCanvas);

            revokeObjectUrl(state.processedUrl);
            state.processedBlob = processedBlob;
            state.processedUrl = URL.createObjectURL(processedBlob);
            state.comparisonRatio = 0.5;

            await setImageSource(UI.imgAfter, state.processedUrl);
            switchZone("result");
            syncComparisonLayout();
            updateControls();
            setEditorStatus(
                state.cvReady
                    ? "Done. Preview is downscaled for speed; Download PNG keeps the original resolution."
                    : "Done with the built-in local fill engine. Download PNG keeps the original resolution.",
                "ready"
            );
        } catch (error) {
            console.error(error);
            setEditorStatus(error.message || "Processing failed. Try adjusting the mask and run again.", "error");
        } finally {
            state.processing = false;
            setLoadingState(false);
            updateControls();
        }
    };

    const downloadProcessedImage = () => {
        if (!state.processedBlob || !state.processedUrl) return;

        const link = document.createElement("a");
        link.href = state.processedUrl;
        link.download = `${sanitizeFileName(state.imageFile?.name)}-clean.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const clearMask = () => {
        if (!hasMask()) return;
        invalidateProcessedOutput();
        resetEditorState();
        renderMasks();
        setEditorStatus("Mask cleared. Paint a new area or enable auto-detect again.", "neutral");
    };

    const undoLastStroke = () => {
        if (!state.manualStrokes.length) return;
        invalidateProcessedOutput();
        state.manualStrokes.pop();
        renderMasks();
        setEditorStatus(
            state.manualStrokes.length
                ? "Removed the last manual stroke."
                : "No manual strokes left. Auto-detect, if enabled, is still available.",
            "neutral"
        );
    };

    const bindEvents = () => {
        UI.btnChooseFile.addEventListener("click", () => openFilePicker());
        UI.dropArea.addEventListener("click", (event) => {
            if (event.target.closest("button")) return;
            openFilePicker();
        });

        UI.dropArea.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openFilePicker();
        });

        UI.fileInput.addEventListener("change", (event) => {
            handleFile(event.target.files[0]);
        });

        ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
            UI.dropArea.addEventListener(eventName, (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (eventName === "dragover" && event.dataTransfer) {
                    event.dataTransfer.dropEffect = "copy";
                }
            });
        });

        ["dragenter", "dragover"].forEach((eventName) => {
            UI.dropArea.addEventListener(eventName, () => {
                UI.dropArea.classList.add("drag-active");
            });
        });

        ["dragleave", "drop"].forEach((eventName) => {
            UI.dropArea.addEventListener(eventName, () => {
                UI.dropArea.classList.remove("drag-active");
            });
        });

        UI.dropArea.addEventListener("drop", (event) => {
            const file = getFirstTransferredFile(event.dataTransfer);
            handleFile(file);
        });

        ["dragover", "drop"].forEach((eventName) => {
            window.addEventListener(eventName, (event) => {
                event.preventDefault();
            });
        });

        UI.brushSizeInput.addEventListener("input", (event) => {
            UI.brushSizeVal.textContent = `${event.target.value}px`;
        });

        UI.maskCanvas.addEventListener("pointerdown", onMaskPointerDown);
        UI.maskCanvas.addEventListener("pointermove", onMaskPointerMove);
        UI.maskCanvas.addEventListener("pointerup", finishStroke);
        UI.maskCanvas.addEventListener("pointercancel", finishStroke);
        UI.maskCanvas.addEventListener("pointerleave", finishStroke);

        UI.autoDetectToggle.addEventListener("change", handleAutoDetectChange);
        UI.btnUndo.addEventListener("click", undoLastStroke);
        UI.btnClear.addEventListener("click", clearMask);
        UI.btnErase.addEventListener("click", processImage);
        UI.btnDownload.addEventListener("click", downloadProcessedImage);
        UI.btnBack.addEventListener("click", clearWorkspace);

        window.addEventListener("resize", () => {
            if (state.originalImage && UI.zones.editor.classList.contains("active")) {
                updateEditorForCurrentImage();
            }
            if (UI.zones.result.classList.contains("active")) {
                syncComparisonLayout();
            }
        });
    };

    const init = async () => {
        setUploadFeedback(DEFAULT_UPLOAD_MESSAGE, "neutral");
        setEditorStatus("Choose an image to begin. Masking and erase stay local.", "neutral");
        updateMaskIndicators();
        updateResolutionBadges();
        updateControls();
        initializeComparisonSlider();
        bindEvents();
        updateControls();
    };

    init();
});
