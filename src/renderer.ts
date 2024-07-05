import { Mat4, mat4 } from 'wgpu-matrix';
import { RenderUniformsBuffer } from './passes/renderUniformsBuffer.ts';
import {
  Dimensions,
  createCameraProjectionMat,
  debounce,
  getViewProjectionMatrix,
} from './utils/index.ts';
import Input from './sys_web/input.ts';
import { CONFIG, DEPTH_FORMAT, HDR_RENDER_TEX_FORMAT } from './constants.ts';
import { DrawNanitesPass } from './passes/naniteCpu/drawNanitesPass.ts';
import { Camera } from './camera.ts';
import { PassCtx } from './passes/passCtx.ts';
import { DbgMeshoptimizerPass } from './passes/debug/dbgMeshoptimizerPass.ts';
import { DbgMeshoptimizerMeshletsPass } from './passes/debug/dbgMeshoptimizerMeshletsPass.ts';
import { DrawNaniteGPUPass } from './passes/naniteGpu/drawNaniteGPUPass.ts';
import { NaniteVisibilityPass } from './passes/naniteGpu/naniteVisibilityPass.ts';
import { GpuProfiler } from './gpuProfiler.ts';
import { Scene } from './scene/scene.ts';
import { Frustum } from './utils/frustum.ts';
import { assertIsGPUTextureView } from './utils/webgpu.ts';
import { DepthPyramidPass } from './passes/depthPyramid/depthPyramidPass.ts';
import { DepthPyramidDebugDrawPass } from './passes/depthPyramid/depthPyramidDebugDrawPass.ts';
import { CullInstancesPass } from './passes/cullInstances/cullInstancesPass.ts';
import { NaniteBillboardPass } from './passes/naniteBillboard/naniteBillboardPass.ts';
import { PresentPass } from './passes/presentPass/presentPass.ts';

export class Renderer {
  private readonly renderUniformBuffer: RenderUniformsBuffer;
  public readonly cameraCtrl: Camera;
  private readonly cameraFrustum: Frustum = new Frustum();
  private projectionMat: Mat4;
  private readonly _viewMatrix = mat4.identity(); // cached to prevent allocs.
  private frameIdx = 0;

  // render target textures
  private depthTexture: GPUTexture = undefined!; // see this.handleViewportResize()
  private depthTextureView: GPUTextureView = undefined!; // see this.handleViewportResize()
  private hdrRenderTexture: GPUTexture = undefined!; // see this.handleViewportResize()
  private hdrRenderTextureView: GPUTextureView = undefined!; // see this.handleViewportResize()

  // passes
  private readonly drawMeshPass: DrawNanitesPass;
  private readonly drawNaniteGPUPass: DrawNaniteGPUPass;
  private readonly naniteVisibilityPass: NaniteVisibilityPass;
  private readonly cullInstancesPass: CullInstancesPass;
  private readonly naniteBillboardPass: NaniteBillboardPass;
  private readonly presentPass: PresentPass;
  // depth pyramid
  private readonly depthPyramidPass: DepthPyramidPass;
  private readonly depthPyramidDebugDrawPass: DepthPyramidDebugDrawPass;
  // debug
  private readonly dbgMeshoptimizerPass: DbgMeshoptimizerPass;
  private readonly dbgMeshoptimizerMeshletsPass: DbgMeshoptimizerMeshletsPass;

  constructor(
    private readonly device: GPUDevice,
    viewportSize: Dimensions,
    preferredCanvasFormat: GPUTextureFormat,
    private readonly profiler?: GpuProfiler
  ) {
    this.renderUniformBuffer = new RenderUniformsBuffer(device);

    this.drawMeshPass = new DrawNanitesPass(device, HDR_RENDER_TEX_FORMAT);
    this.drawNaniteGPUPass = new DrawNaniteGPUPass(
      device,
      HDR_RENDER_TEX_FORMAT
    );
    this.naniteVisibilityPass = new NaniteVisibilityPass(device);
    this.cullInstancesPass = new CullInstancesPass(device);
    this.naniteBillboardPass = new NaniteBillboardPass(
      device,
      HDR_RENDER_TEX_FORMAT
    );
    this.depthPyramidPass = new DepthPyramidPass(device);
    this.depthPyramidDebugDrawPass = new DepthPyramidDebugDrawPass(
      device,
      HDR_RENDER_TEX_FORMAT
    );
    this.presentPass = new PresentPass(device, preferredCanvasFormat);

    // geometry debug passes
    this.dbgMeshoptimizerPass = new DbgMeshoptimizerPass(
      device,
      HDR_RENDER_TEX_FORMAT,
      this.renderUniformBuffer
    );
    this.dbgMeshoptimizerMeshletsPass = new DbgMeshoptimizerMeshletsPass(
      device,
      HDR_RENDER_TEX_FORMAT,
      this.renderUniformBuffer
    );

    this.cameraCtrl = new Camera();
    this.projectionMat = createCameraProjectionMat(viewportSize);

    this.handleViewportResize(viewportSize);
  }

  updateCamera(deltaTime: number, input: Input): Mat4 {
    this.cameraCtrl.update(deltaTime, input);
  }

  cmdRender(
    cmdBuf: GPUCommandEncoder,
    scene: Scene,
    viewport: Dimensions,
    screenTexture: GPUTextureView
  ) {
    assertIsGPUTextureView(screenTexture);

    const viewMatrix = this.cameraCtrl.viewMatrix;
    const vpMatrix = getViewProjectionMatrix(
      viewMatrix,
      this.projectionMat,
      this._viewMatrix
    );
    this.cameraFrustum.update(vpMatrix);
    const [_depthPyramidTex, depthPyramidTexView] =
      this.depthPyramidPass.verifyResultTexture(
        this.device,
        this.depthTexture,
        this.depthTextureView
      );
    const ctx: PassCtx = {
      frameIdx: this.frameIdx,
      cmdBuf,
      viewport,
      scene,
      hdrRenderTexture: this.hdrRenderTextureView,
      device: this.device,
      profiler: this.profiler,
      viewMatrix,
      vpMatrix,
      projMatrix: this.projectionMat,
      cameraFrustum: this.cameraFrustum,
      cameraPositionWorldSpace: this.cameraCtrl.positionWorldSpace,
      depthTexture: this.depthTextureView,
      prevFrameDepthPyramidTexture: depthPyramidTexView,
      globalUniforms: this.renderUniformBuffer,
      depthPyramidSampler: this.depthPyramidPass.depthSampler,
    };

    this.renderUniformBuffer.update(ctx);

    if (CONFIG.displayMode === 'dbg-lod') {
      this.dbgMeshoptimizerPass.draw(ctx);
    } else if (
      CONFIG.displayMode === 'dbg-lod-meshlets' ||
      CONFIG.displayMode === 'dbg-nanite-meshlets'
    ) {
      this.dbgMeshoptimizerMeshletsPass.draw(ctx);
    } else {
      // draw nanite - calc visibility either CPU or GPU
      if (CONFIG.nanite.render.calcVisibilityDevice === 'gpu') {
        this.cmdDrawNanite_GPU(ctx);
      } else {
        this.cmdDrawNanite_CPU(ctx);
      }
    }

    this.presentPass.cmdDraw(ctx, screenTexture);

    this.frameIdx += 1;
  }

  private cmdDrawNanite_CPU(ctx: PassCtx) {
    const { naniteObjects } = ctx.scene;

    this.drawMeshPass.initFrameStats();

    // draw objects
    for (let i = 0; i < naniteObjects.length; i++) {
      const naniteObject = naniteObjects[i];
      const loadOp: GPULoadOp = i == 0 ? 'clear' : 'load';

      this.drawMeshPass.draw(ctx, naniteObject, loadOp);
    }

    this.drawMeshPass.uploadFrameStats(ctx);
  }

  private cmdDrawNanite_GPU(ctx: PassCtx) {
    const { naniteObjects } = ctx.scene;

    // draw objects
    for (let i = 0; i < naniteObjects.length; i++) {
      const naniteObject = naniteObjects[i];
      const loadOp: GPULoadOp = i == 0 ? 'clear' : 'load';

      if (!CONFIG.nanite.render.freezeGPU_Visibilty) {
        if (CONFIG.cullingInstances.enabled) {
          this.cullInstancesPass.cmdCullInstances(ctx, naniteObject);
        }
        this.naniteVisibilityPass.cmdCalculateVisibility(ctx, naniteObject);
      }
      this.drawNaniteGPUPass.draw(ctx, naniteObject, loadOp);

      if (CONFIG.cullingInstances.enabled) {
        this.naniteBillboardPass.cmdRenderBillboards(ctx, naniteObject, 'load');
      }
    }

    // depth pyramid
    this.depthPyramidPass.cmdCreateDepthPyramid(
      ctx,
      this.depthTexture,
      this.depthTextureView
    );
    CONFIG.nanite.render.hasValidDepthPyramid = true;

    if (CONFIG.displayMode === 'dbg-depth-pyramid') {
      this.depthPyramidDebugDrawPass.cmdDraw(ctx);
    }
  }

  private handleViewportResize = (viewportSize: Dimensions) => {
    console.log(`Viewport resize`, viewportSize);
    CONFIG.nanite.render.hasValidDepthPyramid = false;

    this.projectionMat = createCameraProjectionMat(viewportSize);

    if (this.depthTexture) {
      this.depthTexture.destroy();
    }
    if (this.hdrRenderTexture) {
      this.hdrRenderTexture.destroy();
    }

    const vpStr = `${viewportSize.width}x${viewportSize.height}`;

    this.hdrRenderTexture = this.device.createTexture({
      label: `hdr-texture-${vpStr}`,
      size: [viewportSize.width, viewportSize.height],
      format: HDR_RENDER_TEX_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.hdrRenderTextureView = this.hdrRenderTexture.createView();

    this.depthTexture = this.device.createTexture({
      label: `depth-texture-${vpStr}`,
      size: [viewportSize.width, viewportSize.height],
      format: DEPTH_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.depthTextureView = this.depthTexture.createView();

    // reset bindings that used texture
    this.depthPyramidDebugDrawPass.onViewportResize();
    this.naniteVisibilityPass.onViewportResize();
    this.cullInstancesPass.onViewportResize();
    this.depthPyramidPass.verifyResultTexture(
      this.device,
      this.depthTexture,
      this.depthTextureView,
      true
    );
    this.presentPass.onViewportResize();
  };

  onCanvasResize = debounce(this.handleViewportResize, 500);
}
