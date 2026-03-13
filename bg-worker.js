/* ==========================================================
 *  bg-worker.js  –  AI Background Removal Web Worker
 *  Uses @xenova/transformers (RMBG-1.4) loaded via importScripts
 * ========================================================== */

// Classic Worker → importScripts is available
importScripts('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js');

// Configure transformers environment
self.transformers.env.allowLocalModels = false;
self.transformers.env.useBrowserCache = true;

class BackgroundRemovalPipeline {
    static model_id = 'briaai/RMBG-1.4';
    static model = null;
    static processor = null;

    static async getInstance(progress_callback = null) {
        if (this.model === null || this.processor === null) {
            this.model = self.transformers.AutoModel.from_pretrained(this.model_id, {
                quantized: true,
                progress_callback,
                config: { model_type: 'custom' }
            });
            this.processor = self.transformers.AutoProcessor.from_pretrained(this.model_id, {
                progress_callback,
                config: {
                    // CRITICAL FIX: RMBG-1.4 lacks preprocessor_config.json, so we MUST specify this
                    feature_extractor_type: 'ImageFeatureExtractor',
                    do_normalize: true,
                    do_pad: false,
                    do_rescale: true,
                    do_resize: true,
                    resample: 2, // 2 = BILINEAR
                    size: { width: 1024, height: 1024 },
                    image_mean: [0.5, 0.5, 0.5],
                    image_std: [0.5, 0.5, 0.5],
                }
            });
        }
        return Promise.all([this.model, this.processor]);
    }
}

self.addEventListener('message', async (event) => {
    const { type, imageSrc, id } = event.data;

    if (type === 'load') {
        try {
            await BackgroundRemovalPipeline.getInstance(data => {
                self.postMessage({ type: 'progress', data });
            });
            self.postMessage({ type: 'ready' });
        } catch (e) {
            console.error('Load Error:', e);
            self.postMessage({ type: 'error', error: e.message || 'Model load failed' });
        }

    } else if (type === 'process') {
        try {
            const [model, processor] = await BackgroundRemovalPipeline.getInstance();
            const image = await self.transformers.RawImage.read(imageSrc);
            const { pixel_values } = await processor(image);
            const { output } = await model({ input: pixel_values });

            const mask = await self.transformers.RawImage
                .fromTensor(output[0].mul(255).to('uint8'))
                .resize(image.width, image.height);

            self.postMessage({
                type: 'result',
                id,
                maskData: mask.data,
                width: mask.width,
                height: mask.height
            }, [mask.data.buffer]);
        } catch (error) {
            console.error('Process Error:', error);
            self.postMessage({ type: 'error', id, error: error.message || 'Process failed' });
        }
    }
});
