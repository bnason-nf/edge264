/* (c) 2024 Netflix, Inc.Do not copy or use without prior written permission from Netflix, Inc. */

/* global console, globalThis, nrdp, nrdp_platform, queueMicrotask, logScriptRenderInstrumentation, URL */

const isNrdp = typeof nrdp !== "undefined";
const isBrowser = !isNrdp && typeof window !== "undefined";
if (!isNrdp && !isBrowser) {
    console.error("[WASM_TEST] Unsupported environment: not running in NRDP or browser context");
}
if (isBrowser) {
    if (!navigator.gpu) {
        console.error("[WASM_TEST] WebGPU is not supported in this browser");
    }

    if (typeof queueMicrotask === "undefined") {
        globalThis.queueMicrotask = (callback) => Promise.resolve().then(callback);
    }
}

function NVERBOSE(...args) {
    if (isNrdp) {
        nrdp.l.verbose({ traceArea: "WASM_TEST", noDataBufferData: true }, ...args);
    } else {
        console.debug("[WASM_TEST]", ...args);
    }
}
function NTRACE(...args) {
    if (isNrdp) {
        nrdp.l.trace({ traceArea: "WASM_TEST", noDataBufferData: true }, ...args);
    } else {
        console.log("[WASM_TEST]", ...args);
    }
}
function NFATAL(...args) {
    if (isNrdp) {
        nrdp.l.fatal({ traceArea: "WASM_TEST", noDataBufferData: true }, ...args);
    } else {
        console.error("[WASM_TEST] FATAL:", ...args);
    }
}
function NERROR(...args) {
    if (isNrdp) {
        nrdp.l.error({ traceArea: "WASM_TEST", noDataBufferData: true }, ...args);
    } else {
        console.error("[WASM_TEST]", ...args);
    }
}
function NWARN(...args) {
    if (isNrdp) {
        nrdp.l.warn({ traceArea: "WASM_TEST", noDataBufferData: true }, ...args);
    } else {
        console.warn("[WASM_TEST]", ...args);
    }
}
function NINFO(...args) {
    if (isNrdp) {
        nrdp.l.info({ traceArea: "WASM_TEST", noDataBufferData: true }, ...args);
    } else {
        console.info("[WASM_TEST]", ...args);
    }
}

if (isNrdp) {
    console.log = NINFO;
}

// WASM memory management functions
let malloc;
let free;

// Edge264 decoder API functions
let edge264_alloc;
let edge264_get_frame;
let edge264_decode_NAL;
let edge264_flush;
let edge264_free;

let memoryManager;
let webgpuBase;
let videoPlayer = null;
let animationFrameId = null;

class MemoryManager {
    constructor() {
        this.memory = null;
        this.memoryU8 = null;
        this.memoryU16 = null;
        this.memoryU32 = null;
        this.memoryGrowthListeners = [];
    }

    addMemoryGrowthListener(listener) {
        if (typeof listener === "function") {
            this.memoryGrowthListeners.push(listener);
        } else if (listener && typeof listener.updateMemoryViews === "function") {
            this.memoryGrowthListeners.push(() => listener.updateMemoryViews());
        }
    }

    removeMemoryGrowthListener(listener) {
        const index = this.memoryGrowthListeners.indexOf(listener);
        if (index > -1) {
            this.memoryGrowthListeners.splice(index, 1);
        }
    }

    notifyMemoryGrowthListeners() {
        for (const listener of this.memoryGrowthListeners) {
            try {
                listener();
            } catch (error) {
                NERROR("Error in memory growth listener:", error);
            }
        }
    }

    setMemory(wasmMemory) {
        this.memory = wasmMemory;

        // Wrap the grow() function to detect memory growth
        if (this.memory && typeof this.memory.grow === "function") {
            const originalGrow = this.memory.grow.bind(this.memory);
            this.memory.grow = (pages) => {
                NINFO("Memory.grow() called with pages:", pages);
                const result = originalGrow(pages);

                if (result >= 0) {
                    // grow() returns previous page count on success
                    this.updateMemoryViews();
                    this.notifyMemoryGrowthListeners();
                }

                return result;
            };
        }

        this.updateMemoryViews();
    }

    getMemory() {
        return this.memory;
    }

    getMemoryU8() {
        return this.memoryU8;
    }

    getMemoryU16() {
        return this.memoryU16;
    }

    getMemoryU32() {
        return this.memoryU32;
    }

    updateMemoryViews() {
        if (!this.memory || !this.memory.buffer) {
            NERROR("WASM memory is not initialized");
            return;
        }

        this.memoryU8 = new Uint8Array(this.memory.buffer);
        this.memoryU16 = new Uint16Array(this.memory.buffer);
        this.memoryU32 = new Uint32Array(this.memory.buffer);
    }
}
class WebGPUBase {
    constructor() {
        this.gpu = null;
        this.adapter = null;
        this.device = null;
        this.canvasFormat = null;
    }

    async init() {
        NTRACE("Initializing WebGPU base");

        this.gpu = typeof nrdp_platform !== "undefined" ? nrdp_platform.gpu : navigator.gpu;

        this.adapter = await this.gpu.requestAdapter({
            label: "VideoDecoder WebGPU Adapter",
        });
        if (!this.adapter) {
            NERROR("Failed to get WebGPU adapter");
            return false;
        }

        this.device = await this.adapter.requestDevice({
            label: "VideoDecoder WebGPU Device",
        });
        if (!this.device) {
            NERROR("Failed to get WebGPU device");
            return false;
        }

        this.canvasFormat = this.gpu.getPreferredCanvasFormat();
        if (!this.canvasFormat) {
            NERROR("Failed to get preferred canvas format");
            return false;
        }

        if (typeof nrdp_platform !== "undefined") {
            this.context = nrdp_platform.canvasContext;
            if (!this.context) {
                NERROR("nrdp_platform.canvasContext is null or undefined");
                return false;
            }
        } else {
            const canvas = document.getElementById("canvas");
            if (!canvas) {
                NERROR("Canvas element with id 'canvas' not found");
                return false;
            }

            // Check if WebGPU is supported before requesting context
            if (!navigator.gpu) {
                NERROR("WebGPU is not supported in this browser");
                return false;
            }

            this.context = canvas.getContext("webgpu");
            if (!this.context) {
                NERROR("Failed to get WebGPU canvas context - WebGPU may not be enabled or supported");
                return false;
            }
        }

        this.context.configure({
            device: this.device,
            format: this.canvasFormat,
        });

        return true;
    }

    deinit() {
        NTRACE("Cleaning up WebGPU base");

        this.canvasFormat = null;
        this.device = undefined;
        this.adapter = undefined;
        this.gpu = undefined;
    }

    getCanvasFormat() {
        return this.canvasFormat;
    }

    renderBegin() {
        return this.device.createCommandEncoder({
            label: "Main Command Encoder",
        });
    }

    renderEnd(commandEncoder) {
        this.device.queue.submit([commandEncoder.finish()]);
    }
}

class VideoRenderer {
    constructor(webgpuBase) {
        this.webgpuBase = webgpuBase;
        this.renderPipeline = null;
        this.yTexture = null;
        this.cbTexture = null;
        this.crTexture = null;
        this.alphaTexture = null;
        this.bindGroup = null;
        this.shaderModule = null;
        this.sampler = null;
        this.opaqueAlphaArray = null;
        this.opaqueAlphaArraySize = 0;

        // Configurable destination rectangle (normalized device coordinates)
        this.destRect = [-1.0, -1.0, 2.0, 2.0]; // x, y, width, height
        this.uniformBuffer = null;
        this.lastUniformData = null;
        this.uniformData = new Float32Array(8); // Cache for uniform updates (dest_rect + flip_y + padding)

        // Track current texture dimensions to avoid unnecessary recreations
        this.currentWidth = 0;
        this.currentHeight = 0;
    }

    async init() {
        NTRACE("Initializing VideoRenderer");

        const shaderCode = `
            struct VertexOutput {
                @builtin(position) pos: vec4<f32>,
                @location(0) tex_coords: vec2<f32>,
            }

            struct Uniforms {
                dest_rect: vec4<f32>, // x, y, width, height in NDC
                flip_y: f32, // 1.0 to flip Y, 0.0 to not flip
            }

            @group(0) @binding(0) var<uniform> uniforms: Uniforms;

            // Generate vertices for full quad: triangle list (0,0), (1,0), (0,1), (1,0), (1,1), (0,1)
            const uvs = array<vec2<f32>, 6>(
                vec2<f32>(0.0, 0.0),
                vec2<f32>(1.0, 0.0),
                vec2<f32>(0.0, 1.0),
                vec2<f32>(1.0, 0.0),
                vec2<f32>(1.0, 1.0),
                vec2<f32>(0.0, 1.0)
            );

            @vertex
            fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
                var out: VertexOutput;

                // Position
                let pos = uniforms.dest_rect.xy + (uvs[idx] * uniforms.dest_rect.zw);
                out.pos = vec4<f32>(pos, 0.0, 1.0);

                // Texture coordinates
                let y_coord = select(uvs[idx].y, 1.0 - uvs[idx].y, uniforms.flip_y < 0.5);
                out.tex_coords = vec2<f32>(uvs[idx].x, y_coord);

                return out;
            }

            @group(0) @binding(1) var y_texture: texture_2d<f32>;
            @group(0) @binding(2) var cb_texture: texture_2d<f32>;
            @group(0) @binding(3) var cr_texture: texture_2d<f32>;
            @group(0) @binding(4) var alpha_texture: texture_2d<f32>;
            @group(0) @binding(5) var tex_sampler: sampler;

            // Precomputed YUV to RGB conversion matrix (ITU-R BT.709)
            const YUV_TO_RGB_MAT = mat3x3<f32>(
                1.0,      1.0,      1.0,
                0.0,     -0.21482,  2.12798,
                1.28033, -0.38059,  0.0
            );

            @fragment
            fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
                // Alpha - convert from limited range (16-235) to full range (0-1)
                let alpha_raw = textureSample(alpha_texture, tex_sampler, in.tex_coords).r;
                let alpha = clamp((alpha_raw - 16.0/255.0) / (235.0/255.0 - 16.0/255.0), 0.0, 1.0);

                // YUV - convert from limited range to full range
                let y_raw = textureSample(y_texture, tex_sampler, in.tex_coords).r;
                let y = clamp((y_raw - 16.0/255.0) / (235.0/255.0 - 16.0/255.0), 0.0, 1.0);

                let cb_raw = textureSample(cb_texture, tex_sampler, in.tex_coords).r;
                let cb = clamp((cb_raw - 16.0/255.0) / (240.0/255.0 - 16.0/255.0), 0.0, 1.0) - 0.5;

                let cr_raw = textureSample(cr_texture, tex_sampler, in.tex_coords).r;
                let cr = clamp((cr_raw - 16.0/255.0) / (240.0/255.0 - 16.0/255.0), 0.0, 1.0) - 0.5;

                // YUV to RGB conversion
                let yuv = vec3<f32>(y, cb, cr);
                let rgb = YUV_TO_RGB_MAT * yuv;

                // Return premultiplied RGB
                return vec4<f32>(rgb * alpha, alpha);
            }
        `;

        this.shaderModule = this.webgpuBase.device.createShaderModule({
            label: "VideoRenderer YUV to RGB Shader",
            code: shaderCode,
        });

        // Create uniform buffer
        this.uniformBuffer = this.webgpuBase.device.createBuffer({
            label: "VideoRenderer Uniform Buffer",
            size: 32, // 8 floats * 4 bytes each (dest_rect + flip_y + padding to 16-byte alignment)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.updateUniformBuffer();

        // Create reusable sampler
        this.sampler = this.webgpuBase.device.createSampler({
            label: "VideoRenderer Linear Sampler",
            magFilter: "linear",
            minFilter: "linear",
        });

        // Create explicit bind group layout
        this.bindGroupLayout = this.webgpuBase.device.createBindGroupLayout({
            label: "VideoRenderer Bind Group Layout",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" },
                },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            ],
        });

        const pipelineLayout = this.webgpuBase.device.createPipelineLayout({
            label: "VideoRenderer Pipeline Layout",
            bindGroupLayouts: [this.bindGroupLayout],
        });

        this.renderPipeline = this.webgpuBase.device.createRenderPipeline({
            label: "VideoRenderer YUV to RGB Pipeline",
            layout: pipelineLayout,
            vertex: {
                module: this.shaderModule,
                entryPoint: "vs_main",
            },
            fragment: {
                module: this.shaderModule,
                entryPoint: "fs_main",
                targets: [
                    {
                        format: this.webgpuBase.getCanvasFormat(),
                        blend: {
                            color: {
                                srcFactor: "one",
                                dstFactor: "one-minus-src-alpha",
                                operation: "add",
                            },
                            alpha: {
                                srcFactor: "one",
                                dstFactor: "one-minus-src-alpha",
                                operation: "add",
                            },
                        },
                        writeMask: GPUColorWrite.ALL,
                    },
                ],
            },
            primitive: {
                topology: "triangle-list",
                frontFace: "ccw",
                cullMode: "none",
            },
        });

        return true;
    }

    deinit() {
        NTRACE("Cleaning up VideoRenderer");

        if (this.yTexture) {
            this.yTexture.destroy();
            this.yTexture = undefined;
        }

        if (this.cbTexture) {
            this.cbTexture.destroy();
            this.cbTexture = undefined;
        }

        if (this.crTexture) {
            this.crTexture.destroy();
            this.crTexture = undefined;
        }

        if (this.alphaTexture) {
            this.alphaTexture.destroy();
            this.alphaTexture = undefined;
        }

        if (this.uniformBuffer) {
            this.uniformBuffer.destroy();
            this.uniformBuffer = undefined;
        }

        if (this.sampler) {
            this.sampler = undefined;
        }

        this.bindGroup = undefined;
        this.bindGroupLayout = undefined;
        this.renderPipeline = undefined;
        this.shaderModule = undefined;
        this.opaqueAlphaArray = null;
        this.opaqueAlphaArraySize = 0;
        this.lastUniformData = null;
        this.currentWidth = 0;
        this.currentHeight = 0;
    }

    setDestinationRect(x, y, width, height) {
        this.destRect = [x, y, width, height];
        this.updateUniformBuffer();
    }

    calculateAspectRatioRect(sourceWidth, sourceHeight) {
        if (!sourceWidth || !sourceHeight) {
            return this.destRect;
        }

        const [destX, destY, destWidth, destHeight] = this.destRect;
        const sourceAspect = sourceWidth / sourceHeight;
        const desiredAspectRatio = 16 / 9;

        let finalWidth, finalHeight, finalX, finalY;

        if (sourceAspect > desiredAspectRatio) {
            // letterbox
            finalWidth = destWidth;
            finalHeight = (destHeight * desiredAspectRatio) / sourceAspect;
            finalX = destX;
            finalY = destY + (destHeight - finalHeight) / 2;
        } else {
            // pillarbox
            finalWidth = (destWidth / desiredAspectRatio) * sourceAspect;
            finalHeight = destHeight;
            finalX = destX + (destWidth - finalWidth) / 2;
            finalY = destY;
        }

        return [finalX, finalY, finalWidth, finalHeight];
    }

    updateUniformBuffer(sourceWidth = null, sourceHeight = null) {
        if (!this.uniformBuffer) {
            NERROR("Uniform buffer not initialized");
            return;
        }

        const rect =
            sourceWidth && sourceHeight ? this.calculateAspectRatioRect(sourceWidth, sourceHeight) : this.destRect;

        const flipY = isNrdp && this.webgpuBase.gpu.backend === "opengl" ? 1.0 : 0.0;

        for (let i = 0; i < 4; i++) {
            this.uniformData[i] = rect[i];
        }
        this.uniformData[4] = flipY;
        this.uniformData[5] = 0.0;
        this.uniformData[6] = 0.0;
        this.uniformData[7] = 0.0;

        if (this.uniformData !== this.lastUniformData) {
            this.webgpuBase.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
            this.lastUniformData = this.uniformData;
        }
    }

    renderFrame(commandEncoder, decodedFrame, alphaFrame = null) {
        NVERBOSE("renderFrame");

        if (!this.webgpuBase.device || !this.renderPipeline) {
            NWARN("not initialized, skipping render");
            return;
        }

        const { width_Y, height_Y, width_C, height_C, stride_Y, stride_C, yArray, cbArray, crArray } = decodedFrame;

        // Update uniform buffer with aspect ratio calculation
        this.updateUniformBuffer(width_Y, height_Y);

        // Only recreate textures if dimensions have changed or textures don't exist
        const needTextureRecreation =
            !this.yTexture || this.currentWidth !== width_Y || this.currentHeight !== height_Y;

        if (needTextureRecreation) {
            // Clean up existing bind group first to release texture view references
            if (this.bindGroup) {
                this.bindGroup = undefined;
            }

            // Clean up existing textures
            if (this.yTexture) {
                this.yTexture.destroy();
            }
            if (this.cbTexture) {
                this.cbTexture.destroy();
            }
            if (this.crTexture) {
                this.crTexture.destroy();
            }
            if (this.alphaTexture) {
                this.alphaTexture.destroy();
            }

            // Create new textures with current dimensions
            this.yTexture = this.webgpuBase.device.createTexture({
                label: "VideoRenderer Y Texture",
                size: [width_Y, height_Y, 1],
                format: "r8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });

            this.cbTexture = this.webgpuBase.device.createTexture({
                label: "VideoRenderer Cb Texture",
                size: [width_C, height_C, 1],
                format: "r8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });

            this.crTexture = this.webgpuBase.device.createTexture({
                label: "VideoRenderer Cr Texture",
                size: [width_C, height_C, 1],
                format: "r8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });

            // Create alpha texture (same size as Y texture)
            this.alphaTexture = this.webgpuBase.device.createTexture({
                label: "VideoRenderer Alpha Texture",
                size: [width_Y, height_Y, 1],
                format: "r8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });

            // Create new bind group with new textures
            this.bindGroup = this.webgpuBase.device.createBindGroup({
                label: "VideoRenderer Bind Group",
                layout: this.bindGroupLayout,
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: this.uniformBuffer,
                        },
                    },
                    {
                        binding: 1,
                        resource: this.yTexture.createView({
                            label: "Y Texture View",
                        }),
                    },
                    {
                        binding: 2,
                        resource: this.cbTexture.createView({
                            label: "Cb Texture View",
                        }),
                    },
                    {
                        binding: 3,
                        resource: this.crTexture.createView({
                            label: "Cr Texture View",
                        }),
                    },
                    {
                        binding: 4,
                        resource: this.alphaTexture.createView({
                            label: "Alpha Texture View",
                        }),
                    },
                    {
                        binding: 5,
                        resource: this.sampler,
                    },
                ],
            });

            this.currentWidth = width_Y;
            this.currentHeight = height_Y;

            // Resize alpha buffer if needed - properly handle shrinking
            const alphaSize = width_Y * height_Y;
            if (!this.opaqueAlphaArray || this.opaqueAlphaArraySize < alphaSize) {
                // Only grow the buffer, don't shrink to avoid frequent reallocations
                this.opaqueAlphaArray = new Uint8Array(alphaSize).fill(255);
                this.opaqueAlphaArraySize = alphaSize;
            } else if (this.opaqueAlphaArraySize > alphaSize * 4) {
                // Shrink if buffer is more than 4x needed size to prevent memory waste
                this.opaqueAlphaArray = new Uint8Array(alphaSize).fill(255);
                this.opaqueAlphaArraySize = alphaSize;
            }
        }

        this.webgpuBase.device.queue.writeTexture({ texture: this.yTexture }, yArray, { bytesPerRow: stride_Y }, [
            width_Y,
            height_Y,
            1,
        ]);

        this.webgpuBase.device.queue.writeTexture({ texture: this.cbTexture }, cbArray, { bytesPerRow: stride_C }, [
            width_C,
            height_C,
            1,
        ]);

        this.webgpuBase.device.queue.writeTexture({ texture: this.crTexture }, crArray, { bytesPerRow: stride_C }, [
            width_C,
            height_C,
            1,
        ]);

        // Write alpha texture data if alpha frame is provided, otherwise use full opacity
        if (alphaFrame) {
            const { yArray: alphaArray, stride_Y: alphaStride } = alphaFrame;
            this.webgpuBase.device.queue.writeTexture(
                { texture: this.alphaTexture },
                alphaArray,
                { bytesPerRow: alphaStride },
                [width_Y, height_Y, 1],
            );
        } else {
            // Use pre-allocated alpha buffer (sized to current frame)
            // Only write the portion we need
            const alphaSlice = this.opaqueAlphaArray.subarray(0, width_Y * height_Y);
            this.webgpuBase.device.queue.writeTexture(
                { texture: this.alphaTexture },
                alphaSlice,
                { bytesPerRow: width_Y },
                [width_Y, height_Y, 1],
            );
        }

        // Safely get current texture with null check
        const currentTexture = this.webgpuBase.context?.getCurrentTexture();
        if (!currentTexture) {
            NERROR("Failed to get current texture from WebGPU context");
            return;
        }

        const renderPassDescriptor = {
            colorAttachments: [
                {
                    view: currentTexture.createView({
                        label: "Render Target View",
                    }),
                    clearValue: { r: 1.0, g: 0.0, b: 1.0, a: 1.0 },
                    loadOp: "load",
                    storeOp: "store",
                },
            ],
        };

        const renderPass = commandEncoder.beginRenderPass({
            label: "VideoRenderer YUV to RGB Render Pass",
            ...renderPassDescriptor,
        });
        renderPass.setPipeline(this.renderPipeline);
        renderPass.setBindGroup(0, this.bindGroup);
        renderPass.draw(6, 1, 0, 0);
        renderPass.end();
    }
}

class VideoDecoder {
    constructor(name) {
        this.name = name;
        this.wasmBuffer = null;

        this.nalPtr = null;
        this.nalU32 = null;
        this.endPtr = null;
        this.decPtr = null;
        this.decoderFreed = false;

        this.frmPtr = null;
        this.frmU8 = null;
        this.frmU16 = null;
        this.frmU32 = null;

        this.needsNALDecode = true;
        this.currentFrame = null;

        // Frame statistics tracking
        this.decodedFrameCount = 0;
        this.decodedFramesSinceLastLog = 0;
        this.decodeTimeAccumulated = 0;
        this.decodeTimeCount = 0;
        this.pendingDecodeStartTime = 0;
    }

    async init(buffer) {
        NTRACE(`  [${this.name}] VideoDecoder init`);

        // copy the buffer to WASM memory
        const bufferU8 = new Uint8Array(buffer);
        this.bufferLength = bufferU8.length;
        this.bufferPtr = malloc(this.bufferLength);
        NVERBOSE(`  [${this.name}] bufferPtr`, this.bufferPtr);
        this.wasmBuffer = memoryManager.getMemoryU8().subarray(this.bufferPtr, this.bufferPtr + this.bufferLength);
        this.wasmBuffer.set(bufferU8);

        // create a pointer to hold a pointer to the current NAL unit
        // we need to do this because edge264_decode_NAL uses it to return the next NAL unit
        this.nalPtr = malloc(4);
        NVERBOSE(`  [${this.name}] nalPtr`, this.nalPtr);
        this.nalU32 = memoryManager.getMemoryU32().subarray(this.nalPtr / 4, this.nalPtr / 4 + 1);

        this.setNALPointers();

        // allocate memory for the decoded frame structure
        const sizeofEdge264Frame = 64;
        this.frmPtr = malloc(sizeofEdge264Frame);
        NVERBOSE(`  [${this.name}] frmPtr`, this.frmPtr);
        this.frmU8 = memoryManager.getMemoryU8().subarray(this.frmPtr, this.frmPtr + sizeofEdge264Frame);
        this.frmU16 = memoryManager.getMemoryU16().subarray(this.frmPtr / 2, this.frmPtr / 2 + sizeofEdge264Frame / 2);
        this.frmU32 = memoryManager.getMemoryU32().subarray(this.frmPtr / 4, this.frmPtr / 4 + sizeofEdge264Frame / 4);

        this.needsNALDecode = true;

        // create the edge264 decoder
        NTRACE(`  [${this.name}] Creating decoder`);
        this.decPtr = edge264_alloc(0, 0, 0, 0);
        NVERBOSE(`  [${this.name}] decPtr`, this.decPtr);

        if (!this.decPtr) {
            NERROR(`  [${this.name}] Failed to allocate decoder`);
            return false;
        }

        return true;
    }

    deinit() {
        NTRACE(`  [${this.name}] VideoDecoder deinit`);

        this.currentFrame = null;
        this.needsNALDecode = true;

        if (this.decPtr && this.decPtr !== 0 && !this.decoderFreed) {
            try {
                NVERBOSE(`  [${this.name}] Flushing decoder before free`, this.decPtr);
                edge264_flush(this.decPtr);

                // edge264_free takes a pointer-to-pointer
                // allocate a pointer to hold the decoder pointer
                const ptrToDecPtr = malloc(4);
                const memU32 = memoryManager.getMemoryU32();
                memU32[ptrToDecPtr >> 2] = this.decPtr;

                NVERBOSE(`  [${this.name}] Freeing decoder decPtr`, this.decPtr, "via ptrToDecPtr", ptrToDecPtr);
                edge264_free(ptrToDecPtr);

                free(ptrToDecPtr);

                this.decoderFreed = true;
                this.decPtr = undefined;
            } catch (e) {
                NWARN(`  [${this.name}] Failed to free decoder:`, e);
                this.decoderFreed = true;
                this.decPtr = undefined;
            }
        }

        if (this.frmPtr) {
            NVERBOSE(`  [${this.name}] Freeing frmPtr`, this.frmPtr);
            free(this.frmPtr);
            this.frmPtr = undefined;
            this.frmU8 = undefined;
            this.frmU16 = undefined;
            this.frmU32 = undefined;
        }

        this.endPtr = undefined;

        if (this.nalPtr) {
            NVERBOSE(`  [${this.name}] Freeing nalPtr`, this.nalPtr);
            free(this.nalPtr);
            this.nalPtr = undefined;
            this.nalU32 = undefined;
        }

        if (this.bufferPtr) {
            NVERBOSE(`  [${this.name}] Freeing bufferPtr`, this.bufferPtr);
            free(this.bufferPtr);
            this.bufferPtr = undefined;
        }
    }

    setNALPointers() {
        // Validate buffer exists before accessing
        if (!this.wasmBuffer || this.wasmBuffer.length < 4) {
            NERROR(`  [${this.name}] Invalid wasmBuffer in setNALPointers`);
            return;
        }

        // set the nalU32 pointer to the start of the buffer, skipping the [0]001 delimiter
        this.nalU32[0] = this.bufferPtr + 3 + (this.wasmBuffer[2] === 0 ? 1 : 0);
        this.endPtr = this.bufferPtr + this.bufferLength;
        NVERBOSE(`  [${this.name}] nalU32[0]`, this.nalU32[0], "nalPtr", this.nalPtr, "endPtr", this.endPtr);
    }

    reset() {
        NTRACE(`  [${this.name}] Resetting decoder for loop`);
        // Reset NAL pointers to beginning of buffer
        this.setNALPointers();
        // Mark that we need to decode the next NAL
        this.needsNALDecode = true;
        // Reset frame statistics for new loop
        this.decodedFramesSinceLastLog = 0;
    }

    decodeNAL() {
        NVERBOSE(`  [${this.name}] Decoding NAL unit`);
        this.pendingDecodeStartTime = performance.now();
        const decodeRet = edge264_decode_NAL(this.decPtr, this.nalU32[0], this.endPtr, 0, 0, 0, this.nalPtr);

        if (decodeRet !== 0) {
            if (decodeRet === 116) {
                NVERBOSE(`  [${this.name}] End of stream`);
                return "END";
            }
            NERROR(`  [${this.name}] edge264_decode_NAL error:`, decodeRet);
            return "ERROR";
        }

        this.needsNALDecode = false;
        return "OK";
    }

    getNextFrame() {
        NVERBOSE(`  [${this.name}] Getting next frame`);

        while (true) {
            if (this.needsNALDecode) {
                const nalResult = this.decodeNAL();

                if (nalResult === "END") {
                    this.flush();
                    continue;
                }

                if (nalResult === "ERROR") {
                    return null;
                }
            }

            const getFrameRet = edge264_get_frame(this.decPtr, this.frmPtr, 0);
            if (getFrameRet !== 0) {
                this.needsNALDecode = true;
                continue;
            }

            // Accumulate decode time when frame is successfully retrieved
            if (this.pendingDecodeStartTime > 0) {
                const decodeTime = performance.now() - this.pendingDecodeStartTime;
                this.decodeTimeAccumulated += decodeTime;
                this.decodeTimeCount++;
                this.pendingDecodeStartTime = 0;
            }

            let frameData = {
                yPtr: this.frmU32[0],
                cbPtr: this.frmU32[1],
                crPtr: this.frmU32[2],
                FrameId: this.frmU32[11],
                width_Y: this.frmU16[15],
                width_C: this.frmU16[16],
                height_Y: this.frmU16[17],
                height_C: this.frmU16[18],
                stride_Y: this.frmU16[19],
                stride_C: this.frmU16[20],
            };

            // Get current memory views
            const memoryU8 = memoryManager.getMemoryU8();

            frameData.yArray = memoryU8.subarray(
                frameData.yPtr,
                frameData.yPtr + frameData.stride_Y * frameData.height_Y,
            );
            frameData.cbArray = memoryU8.subarray(
                frameData.cbPtr,
                frameData.cbPtr + frameData.stride_C * frameData.height_C,
            );
            frameData.crArray = memoryU8.subarray(
                frameData.crPtr,
                frameData.crPtr + frameData.stride_C * frameData.height_C,
            );

            this.currentFrame = frameData;
            NVERBOSE(`  [${this.name}] Got frame ${frameData.FrameId}`);

            // Track decoded frames
            this.decodedFrameCount++;
            this.decodedFramesSinceLastLog++;

            return frameData;
        }
    }

    flush() {
        // Flush the decoder for resync
        if (this.decPtr) {
            edge264_flush(this.decPtr);
            this.setNALPointers();
            this.needsNALDecode = true;
        }
    }

    logFpsStats() {
        const avgDecodeTime = this.decodeTimeCount > 0 ? this.decodeTimeAccumulated / this.decodeTimeCount : 0;
        NINFO(
            `  [${this.name}] Decoder: ${this.decodedFramesSinceLastLog} fps, avg decode: ${avgDecodeTime.toFixed(
                2,
            )}ms`,
        );

        this.decodedFramesSinceLastLog = 0;
        this.decodeTimeAccumulated = 0;
        this.decodeTimeCount = 0;
    }

    updateMemoryViews() {
        // Validate pointers before updating views
        if (!this.bufferPtr || !this.nalPtr || !this.frmPtr) {
            NERROR(`  [${this.name}] Invalid pointers in updateMemoryViews`);
            return;
        }

        this.wasmBuffer = memoryManager.getMemoryU8().subarray(this.bufferPtr, this.bufferPtr + this.bufferLength);
        this.nalU32 = memoryManager.getMemoryU32().subarray(this.nalPtr / 4, this.nalPtr / 4 + 1);
        this.setNALPointers();

        const sizeofEdge264Frame = 64;
        this.frmU8 = memoryManager.getMemoryU8().subarray(this.frmPtr, this.frmPtr + sizeofEdge264Frame);
        this.frmU16 = memoryManager.getMemoryU16().subarray(this.frmPtr / 2, this.frmPtr / 2 + sizeofEdge264Frame / 2);
        this.frmU32 = memoryManager.getMemoryU32().subarray(this.frmPtr / 4, this.frmPtr / 4 + sizeofEdge264Frame / 4);
    }
}

class VideoPlayer {
    constructor(webgpuBase, frameRate) {
        this.webgpuBase = webgpuBase;
        this.renderer = null;
        this.mainDecoder = null;
        this.alphaDecoder = null;
        this.frameCount = 0;

        // Frame rate control
        this.frameRate = frameRate || 30; // Default to 30 fps if invalid
        this.frameInterval = 1000 / frameRate; // ms between frames
        this.nextFrameTime = 0;
        this.playbackStartTime = 0;

        // Frame consumption statistics
        this.consumedFrameCount = 0;
        this.lastConsumedFrameLogTime = 0;

        // Frame caching for rate control
        this.cachedMainFrame = null;
        this.cachedAlphaFrame = null;
    }

    async init(fileBuffer, alphaFileBuffer = null) {
        NTRACE("VideoPlayer init");

        this.renderer = new VideoRenderer(this.webgpuBase);
        const rendererSuccess = await this.renderer.init();
        if (!rendererSuccess) {
            NERROR("Failed to initialize video renderer");
            return false;
        }

        this.mainDecoder = new VideoDecoder("main");
        const mainSuccess = await this.mainDecoder.init(fileBuffer);
        if (!mainSuccess) {
            NERROR("Failed to initialize main decoder");
            return false;
        }

        if (alphaFileBuffer) {
            this.alphaDecoder = new VideoDecoder("alpha");
            const alphaSuccess = await this.alphaDecoder.init(alphaFileBuffer);
            if (!alphaSuccess) {
                NERROR("Failed to initialize alpha decoder");
                return false;
            }
        }

        return true;
    }

    deinit() {
        NTRACE("VideoPlayer deinit");

        if (this.mainDecoder) {
            this.mainDecoder.deinit();
            this.mainDecoder = null;
        }

        if (this.alphaDecoder) {
            this.alphaDecoder.deinit();
            this.alphaDecoder = null;
        }

        if (this.renderer) {
            this.renderer.deinit();
            this.renderer = null;
        }
    }

    setDestinationRect(x, y, width, height) {
        if (this.renderer) {
            this.renderer.setDestinationRect(x, y, width, height);
        }
    }

    render(commandEncoder) {
        NVERBOSE("VideoPlayer render");

        if (!this.mainDecoder) {
            NERROR("VideoPlayer not initialized");
            return false;
        }

        if (!this.playbackStartTime) {
            this.playbackStartTime = performance.now();
        }
        const now = performance.now() - this.playbackStartTime;

        if (now >= this.nextFrameTime) {
            NVERBOSE(`Consuming new frame at ${now.toFixed(1)}ms, interval: ${this.frameInterval.toFixed(1)}ms`);

            this.nextFrameTime += this.frameInterval;

            this.cachedMainFrame = this.mainDecoder.getNextFrame();
            if (!this.cachedMainFrame) {
                NINFO("End of video reached, looping...");
                this.mainDecoder.reset();
                if (this.alphaDecoder) {
                    this.alphaDecoder.reset();
                }
                this.cachedMainFrame = this.mainDecoder.getNextFrame();
                if (!this.cachedMainFrame) {
                    NERROR("Failed to get main frame after reset");
                    return false;
                }
            }

            if (this.alphaDecoder) {
                this.cachedAlphaFrame = this.alphaDecoder.getNextFrame();
                if (!this.cachedAlphaFrame) {
                    NWARN("Failed to get alpha frame after main frame");
                    return false;
                }

                if (this.cachedMainFrame.FrameId !== this.cachedAlphaFrame.FrameId) {
                    NWARN(
                        `Frame sync mismatch: main=${this.cachedMainFrame.FrameId}, alpha=${this.cachedAlphaFrame.FrameId}`,
                    );
                }
            }

            // Track consumed frames
            this.consumedFrameCount++;

            // Log fps stats once per second (synchronized logging)
            if (now - this.lastConsumedFrameLogTime >= 1000) {
                NINFO(
                    `Player: ${this.consumedFrameCount} fps (target: ${
                        this.frameRate
                    } fps, interval: ${this.frameInterval.toFixed(1)}ms)`,
                );

                this.consumedFrameCount = 0;
                this.lastConsumedFrameLogTime = now;

                if (this.mainDecoder) {
                    this.mainDecoder.logFpsStats();
                }

                if (this.alphaDecoder) {
                    this.alphaDecoder.logFpsStats();
                }
            }
        }

        // Always render the cached frame (may be the same frame multiple times)
        if (this.cachedMainFrame) {
            this.renderer.renderFrame(commandEncoder, this.cachedMainFrame, this.cachedAlphaFrame);
            this.frameCount++;

            // Log progress occasionally
            if (this.frameCount % this.frameRate === 0) {
                NVERBOSE(`Rendered ${this.frameCount} frames`);
            }
        }

        return true;
    }

    updateMemoryViews() {
        if (this.mainDecoder) {
            this.mainDecoder.updateMemoryViews();
        }

        if (this.alphaDecoder) {
            this.alphaDecoder.updateMemoryViews();
        }
    }
}

async function init(exports) {
    NTRACE("init");

    // Initialize memory manager
    memoryManager = new MemoryManager();

    const __wasm_call_ctors = exports.__wasm_call_ctors;

    if (memoryManager.getMemory()) {
        NINFO("Using pre-allocated memory", memoryManager.getMemory());
    } else {
        NINFO("Using exported memory from WASM module");
        if (typeof exports.memory !== "undefined") {
            NINFO("Using exports.memory");
            memoryManager.setMemory(exports.memory);
        } else if (typeof wasmMemory !== "undefined") {
            NINFO("Using wasmMemory");
            memoryManager.setMemory(wasmMemory);
        } else {
            NERROR("WASM module does not export memory");
            throw new Error("WASM module does not export memory");
        }
    }

    malloc = exports.malloc;
    free = exports.free;

    edge264_alloc = exports.edge264_alloc;
    edge264_get_frame = exports.edge264_get_frame;
    edge264_decode_NAL = exports.edge264_decode_NAL;
    edge264_flush = exports.edge264_flush;
    edge264_free = exports.edge264_free;

    if (__wasm_call_ctors) {
        __wasm_call_ctors();
    }

    // Get options from NRDP or URL parameters for browser mode
    let options;
    if (isNrdp) {
        options = nrdp.js_options;
    } else {
        // Parse URL parameters for browser mode
        const urlParams = new URLSearchParams(window.location.search);
        options = {
            filename: urlParams.get("filename") || "./video.h264",
            frameRate: urlParams.get("frameRate") || "30",
            alphaFilename: urlParams.get("alphaFilename"),
        };
    }

    const filename = options.filename;
    if (!filename) {
        NERROR("No filename provided, usage: -J filename=<path>");
        throw new Error("No filename provided");
    }

    const frameRate = parseInt(options.frameRate) || 30;
    NTRACE(`Frame rate set to ${frameRate} fps`);

    NTRACE("Loading", filename);
    let fileBuffer;
    if (filename.startsWith("local://")) {
        // Handle local file selection
        const fileName = filename.replace("local://", "");
        const selectedFile = window.selectedVideoFile;
        if (!selectedFile) {
            NERROR("Local file not found in memory:", fileName);
            throw new Error("Local file not found in memory");
        }
        NTRACE("Reading local file:", selectedFile.name);
        fileBuffer = await selectedFile.arrayBuffer();
    } else {
        // Handle URL fetch
        const file = await fetch(filename);
        fileBuffer = await file.arrayBuffer();
    }
    NTRACE("File loaded, size", fileBuffer.byteLength);
    if (!fileBuffer.byteLength) {
        NERROR("File is empty");
        throw new Error("File is empty");
    }

    let alphaFileBuffer = null;
    const alphaFilename = options.alphaFilename;
    if (alphaFilename) {
        NTRACE("Loading alpha file", alphaFilename);
        if (alphaFilename.startsWith("local://")) {
            // Handle local alpha file selection
            const alphaFileName = alphaFilename.replace("local://", "");
            const selectedAlphaFile = window.selectedAlphaFile;
            if (!selectedAlphaFile) {
                NERROR("Local alpha file not found in memory:", alphaFileName);
                throw new Error("Local alpha file not found in memory");
            }
            NTRACE("Reading local alpha file:", selectedAlphaFile.name);
            alphaFileBuffer = await selectedAlphaFile.arrayBuffer();
        } else {
            // Validate alpha URL format for security
            try {
                const alphaUrl = new URL(alphaFilename);
                if (!["http:", "https:", "file:"].includes(alphaUrl.protocol)) {
                    NERROR("Invalid alpha URL protocol, only http/https/file allowed:", alphaUrl.protocol);
                    throw new Error("Invalid alpha URL protocol");
                }
            } catch (e) {
                // If not a valid URL, assume it's a relative path which is ok
                NTRACE("Using relative alpha path:", alphaFilename);
            }

            // Handle URL fetch
            const alphaFile = await fetch(alphaFilename);
            alphaFileBuffer = await alphaFile.arrayBuffer();
        }
        NTRACE("Alpha file loaded, size", alphaFileBuffer.byteLength);
        if (!alphaFileBuffer.byteLength) {
            NERROR("Alpha file is empty");
            throw new Error("Alpha file is empty");
        }
    }

    webgpuBase = new WebGPUBase();
    const webgpuSuccess = await webgpuBase.init();
    if (!webgpuSuccess) {
        NERROR("Failed to initialize WebGPU base");
        throw new Error("Failed to initialize WebGPU base");
    }

    // Create single video player instance
    videoPlayer = new VideoPlayer(webgpuBase, frameRate);
    const playerSuccess = await videoPlayer.init(fileBuffer, alphaFileBuffer);
    if (!playerSuccess) {
        NERROR("Failed to initialize video player");
        throw new Error("Failed to initialize video player");
    }

    // Register video player as memory growth listener
    memoryManager.addMemoryGrowthListener(videoPlayer);

    if (isNrdp) {
        nrdp.gibbon.scene.shouldIdle = false;
        nrdp_platform.setRender(render);
    } else {
        // For browser mode, start render loop
        const renderLoop = () => {
            render();
            animationFrameId = requestAnimationFrame(renderLoop);
        };
        animationFrameId = requestAnimationFrame(renderLoop);
    }
}

function deinit() {
    NTRACE("deinit");

    if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }

    if (isNrdp) {
        nrdp.gibbon.scene.shouldIdle = true;
        nrdp_platform.setRender(undefined);
    }

    if (videoPlayer) {
        videoPlayer.deinit();
        videoPlayer = null;
    }

    if (webgpuBase) {
        webgpuBase.deinit();
        webgpuBase = undefined;
    }

    edge264_alloc = undefined;
    edge264_get_frame = undefined;
    edge264_decode_NAL = undefined;
    edge264_flush = undefined;
    edge264_free = undefined;

    malloc = undefined;
    free = undefined;

    memoryManager = undefined;
}

function render() {
    NVERBOSE("\nrender");

    if (!videoPlayer) {
        NERROR("VideoPlayer not initialized");
        return;
    }

    // Safely create command encoder with error handling
    let commandEncoder;
    try {
        commandEncoder = webgpuBase.renderBegin();
    } catch (e) {
        NERROR("Failed to create command encoder:", e);
        return;
    }

    // Clear background with animated color spectrum
    const currentTexture = webgpuBase.context?.getCurrentTexture();
    if (!currentTexture) {
        NERROR("Failed to get current texture for background clear");
        return;
    }

    // Animate through color spectrum using time
    const time = performance.now() / 1000; // seconds
    const hue = (time * 0.05) % 1.0;
    const saturation = 1.0;
    const value = 0.5;

    // Convert HSV to RGB
    const c = saturation * value;
    const x = c * (1 - Math.abs(((hue * 6) % 2) - 1));
    const m = value - c;

    let color;
    switch (Math.floor(hue * 6)) {
        case 0:
            color = [c + m, x + m, 0 + m];
            break;
        case 1:
            color = [x + m, c + m, 0 + m];
            break;
        case 2:
            color = [0 + m, c + m, x + m];
            break;
        case 3:
            color = [0 + m, x + m, c + m];
            break;
        case 4:
            color = [x + m, 0 + m, c + m];
            break;
        case 5:
            color = [c + m, 0 + m, x + m];
            break;
        default:
            color = [0, 0, 0];
            break;
    }

    const renderPassDescriptor = {
        colorAttachments: [
            {
                view: currentTexture.createView(),
                clearValue: { r: color[0], g: color[1], b: color[2], a: 1 },
                loadOp: "clear",
                storeOp: "store",
            },
        ],
    };
    const renderPass = commandEncoder.beginRenderPass({
        label: "Background Clear Render Pass",
        ...renderPassDescriptor,
    });
    renderPass.end();

    // Render video player instance
    const result = videoPlayer.render(commandEncoder);
    if (!result) {
        NERROR("Video player render failed");
        deinit();
        throw new Error("Video player render failed");
    }

    try {
        webgpuBase.renderEnd(commandEncoder);
    } catch (e) {
        NERROR("Failed to submit command buffer:", e);
    }
}

function getNullTerminatedString(offset, length) {
    const memoryU8 = memoryManager.getMemoryU8();
    if (length === undefined) {
        length = 0;
        while (memoryU8[offset + length]) {
            ++length;
        }
    }

    const chars = [];
    for (let i = 0; i < length && offset + i < memoryU8.length; ++i) {
        chars.push(String.fromCharCode(memoryU8[offset + i]));
    }
    return chars.join("");
}

async function main() {
    NTRACE("main");

    if (globalThis.wasmExports) {
        NINFO("Reusing existing WASM exports");
        await init(globalThis.wasmExports);
        return;
    }

    if (isNrdp) {
        nrdp.addEventListener("exception", (e) => {
            NFATAL("Got exception", e);
            nrdp.exit(1);
        });

        nrdp.addEventListener("unhandledrejection", (e) => {
            NFATAL("Got unhandled rejection", e);
            nrdp.thread.send({ type: "error", error: e });
            nrdp.exit(1);
        });
    } else {
        window.addEventListener("error", (e) => {
            NFATAL("Got exception", e);
            throw e;
        });

        window.addEventListener("unhandledrejection", (e) => {
            NFATAL("Got unhandled rejection", e);
            throw e;
        });
    }

    if (isNrdp) {
        const polyfill = await import("http://localcontrol.netflix.com/js/browser-polyfill/index.js");
        await polyfill.browserPolyfillInit(globalThis, { render: false });
    }

    if (isNrdp) {
        const url = new URL("./edge264.js", nrdp.gibbon.location);
        nrdp.gibbon.loadScript(url.toString(), (response) => {
            if (response.statusCode === 200) {
                NINFO("loaded emscripten js");

                const interval = nrdp.setInterval(() => {
                    NINFO("waiting for exports...");
                    if (globalThis.wasmExports) {
                        nrdp.clearInterval(interval);
                        NINFO("exports ready");
                        init(globalThis.wasmExports);
                    }
                }, 500);
            } else {
                NWARN("Failed to load emscripten js, falling back to manual wrapper");
                loadManualWrapper();
            }
        });
    } else {
        // Browser mode: try to load edge264.js script
        try {
            const script = document.createElement("script");
            script.src = "./edge264.js";
            script.onload = () => {
                NINFO("loaded emscripten js");
                const checkExports = () => {
                    if (globalThis.wasmExports) {
                        NINFO("exports ready", globalThis.wasmExports);
                        init(globalThis.wasmExports);
                    } else {
                        setTimeout(checkExports, 100);
                    }
                };
                checkExports();
            };
            script.onerror = () => {
                NWARN("Failed to load emscripten js, falling back to manual wrapper");
                loadManualWrapper();
            };
            document.head.appendChild(script);
        } catch (e) {
            NWARN("Error loading emscripten js, falling back to manual wrapper", e);
            loadManualWrapper();
        }
    }

    function loadManualWrapper() {
        NWARN("using manual js wrapper (not working currently)");

        // Initialize memory manager if not already created
        if (!memoryManager) {
            memoryManager = new MemoryManager();
        }

        let wasmMemory;
        const importObject = {
            env: {
                memory: wasmMemory,

                __assert_fail: (e) => {
                    NFATAL("__assert_fail:", getNullTerminatedString(e));
                    throw new Error("Assert failed: " + getNullTerminatedString(e));
                },

                _abort_js: () => {
                    NFATAL("_abort_js");
                },

                emscripten_check_blocking_allowed: () => {
                    NTRACE("emscripten_check_blocking_allowed");
                    if (nrdp.thread.config.main || nrdp.thread.config.animation) {
                        return false;
                    }
                    return true;
                },

                emscripten_exit_with_live_runtime: (status) => {
                    NERROR("emscripten_exit_with_live_runtime", status);
                    if (status !== 0) {
                        NERROR("Exiting with non-zero status", status);
                    }
                    deinit();
                    throw new Error("Emscripten exit with status: " + status);
                },

                emscripten_get_heap_max: () => {
                    return 2 * 1024 * 1024 * 1024; // 2GB
                },

                emscripten_date_now: () => {
                    return Date.now();
                },

                _emscripten_get_now_is_monotonic: () => {
                    return true;
                },

                emscripten_get_now: () => {
                    return performance.now();
                },

                _emscripten_init_main_thread_js: () => {
                    NTRACE("_emscripten_init_main_thread_js");
                    if (isNrdp && (nrdp.thread.config.main || nrdp.thread.config.animation)) {
                        NERROR("_emscripten_init_main_thread_js called in main thread, this should not happen");
                        nrdp.exit(1);
                    }
                },

                _emscripten_memcpy_js: (dest, src, num) => {
                    NTRACE("emscripten_memcpy_js", dest, src, num);
                    return memoryManager.getMemoryU8().copyWithin(dest, src, src + num);
                },

                _emscripten_notify_mailbox_postmessage: (moduleName, mailboxId, messagePtr, messageLength) => {
                    NERROR("emscripten_notify_mailbox_postmessage", moduleName, mailboxId, messagePtr, messageLength);
                    const message = getNullTerminatedString(messagePtr, messageLength);
                    NTRACE(`Mailbox message: ${message} (module: ${moduleName}, mailbox: ${mailboxId})`);
                },

                emscripten_notify_memory_growth: (moduleName) => {
                    NTRACE("emscripten_notify_memory_growth");
                },

                emscripten_num_logical_cores: () => {
                    NERROR("emscripten_num_logical_cores");
                    return 8;
                },

                _emscripten_receive_on_main_thread_js: (moduleName, mailboxId, messagePtr, messageLength) => {
                    NERROR("emscripten_receive_on_main_thread_js", moduleName, mailboxId, messagePtr, messageLength);
                    const message = getNullTerminatedString(messagePtr, messageLength);
                    NTRACE(`Received message: ${message} (module: ${moduleName}, mailbox: ${mailboxId})`);
                },

                emscripten_resize_heap: (size) => {
                    NWARN("emscripten_resize_heap", size);

                    const currentSize = memoryManager.getMemoryU8().byteLength;
                    const pages = Math.ceil((size - currentSize + 65535) / 65536);
                    try {
                        memoryManager.getMemory().grow(pages);
                    } catch (err) {
                        NERROR(
                            `emscripten_resize_heap size: ${size}. Size was ${currentSize}, failed to grow by ${pages} pages`,
                            err,
                        );
                        return 0;
                    }

                    NTRACE(
                        `emscripten_resize_heap size: ${size}. Size was ${currentSize}, grew by ${pages} pages to ${
                            memoryManager.getMemoryU8().byteLength
                        }`,
                    );
                    return 1;
                },

                _emscripten_runtime_keepalive_clear: () => {
                    NERROR("_emscripten_runtime_keepalive_clear");
                },

                _emscripten_thread_cleanup: () => {
                    NERROR("_emscripten_thread_cleanup");
                },

                _emscripten_thread_mailbox_await: (moduleName, mailboxId) => {
                    NERROR("_emscripten_thread_mailbox_await", moduleName, mailboxId);
                },

                _emscripten_thread_set_strongref: (moduleName, mailboxId, strongref) => {
                    NERROR("_emscripten_thread_set_strongref", moduleName, mailboxId, strongref);
                },

                emscripten_unwind_to_js_event_loop: () => {
                    NERROR("emscripten_unwind_to_js_event_loop");
                },

                __pthread_create_js: (threadPtr, attrPtr, startRoutine, arg) => {
                    NERROR("__pthread_create_js", threadPtr, attrPtr, startRoutine, arg);
                },

                _setitimer_js: () => {
                    NERROR("_setitimer_js");
                },
            },
        };

        const responsePromise = fetch("edge264.wasm");
        const instantiateStreamingPromise = WebAssembly.instantiateStreaming(responsePromise, importObject);
        instantiateStreamingPromise.then((instantiatedSource) => {
            NTRACE("WASM module instantiated");
            init(instantiatedSource.instance.exports);
        });
    }
}

async function start() {
    if (isBrowser) {
        NTRACE("Browser mode");

        window.initVideoPlayer = async function () {
            NTRACE("initVideoPlayer");
            if (typeof window.deinit === "function") {
                try {
                    window.deinit();
                } catch (e) {
                    console.warn("Error during deinit:", e);
                }
            }

            await main();
        };

        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get("filename")) {
            window.initVideoPlayer();
        }
    } else {
        NTRACE("NRDP mode");

        if (nrdp.thread.config.animation) {
            NTRACE("Running main in animation thread");
            await main();
        } else {
            NTRACE("Spawning animation thread for main");

            const thread = nrdp.thread.start({ url: nrdp.gibbon.location, animation: true });
            const eventListener = (message) => {
                queueMicrotask(() => {
                    if (message?.type === "done" || message?.type === "error") {
                        if (nrdp.thread.config.main) {
                            nrdp.exit(message?.type === "done" ? 0 : 1);
                        } else {
                            thread.removeEventListener("raw-message", eventListener);
                            thread.stop();
                            nrdp.thread.send(message);
                        }
                    } else {
                        NERROR("Unknown message", message);
                    }
                });
            };
            thread.addEventListener("raw-message", eventListener);

            NWARN("exithack running");
            nrdp.gibbon.addEventListener("key", (e) => {
                NWARN("exithack got key event", e.data);
                const press = e.data.type === "press";
                if (press) {
                    switch (e.data.uiEvent) {
                        case "key.back":
                            NERROR("exithack got key.back");
                            nrdp.exit(0);
                            return;
                    }
                }
            });
        }
    }
}

NERROR("loaded");
start();
