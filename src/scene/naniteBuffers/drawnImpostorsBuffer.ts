import { BYTES_U32 } from '../../constants.ts';
import { WEBGPU_MINIMAL_BUFFER_SIZE } from '../../utils/webgpu.ts';

///////////////////////////
/// SHADER CODE
///////////////////////////

export const BUFFER_DRAWN_IMPOSTORS_PARAMS = (
  bindingIdx: number,
  access: 'read_write' | 'read'
) => /* wgsl */ `

/** arg for https://developer.mozilla.org/en-US/docs/Web/API/GPUComputePassEncoder/dispatchWorkgroupsIndirect */
struct DrawIndirect{
  vertexCount: u32,
  instanceCount: atomic<u32>,
  firstVertex: u32,
  firstInstance : u32,
}
@group(0) @binding(${bindingIdx})
var<storage, ${access}> _drawnImpostorsParams: DrawIndirect;
`;

export const BUFFER_DRAWN_IMPOSTORS_LIST = (
  bindingIdx: number,
  access: 'read_write' | 'read'
) => /* wgsl */ `
@group(0) @binding(${bindingIdx})
var<storage, ${access}> _drawnImpostorsList: array<u32>;
`;

export const BYTES_DRAWN_IMPOSTORS_PARAMS = Math.max(
  WEBGPU_MINIMAL_BUFFER_SIZE,
  4 * BYTES_U32
);

///////////////////////////
/// GPU BUFFER
///////////////////////////

export function createDrawnImpostorsBuffer(
  device: GPUDevice,
  name: string,
  instanceCount: number
): GPUBuffer {
  const arraySizeBytes = BYTES_U32 * instanceCount;

  // TODO [HIGH] extract this to util createStorageBuffer()
  const bufferGpu = device.createBuffer({
    label: `${name}-nanite-billboards`,
    size: BYTES_DRAWN_IMPOSTORS_PARAMS + arraySizeBytes,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.INDIRECT |
      GPUBufferUsage.COPY_DST |
      GPUBufferUsage.COPY_SRC, // for stats, debug etc.
  });

  return bufferGpu;
}
