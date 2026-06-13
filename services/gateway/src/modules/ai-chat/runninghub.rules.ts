export const RUNNINGHUB_INPUT_KIND_TEXT_SUFFIX = 'text-to-image';
export const RUNNINGHUB_INPUT_KIND_IMAGE_SUFFIX = 'image-to-image';
export const RUNNINGHUB_INPUT_KIND_LEGACY_IMAGE_SUFFIX = 'edit';
export const RUNNINGHUB_INPUT_KIND_TEXT_TO_VIDEO_SUFFIX = 'text-to-video';
export const RUNNINGHUB_INPUT_KIND_IMAGE_TO_VIDEO_SUFFIX = 'image-to-video';
export const RUNNINGHUB_INPUT_KIND_REFERENCE_TO_VIDEO_SUFFIX = 'reference-to-video';
export const RUNNINGHUB_INPUT_KIND_MULTIMODAL_VIDEO_SUFFIX = 'multimodal-video';

export type RunningHubConcreteInputKind =
  | 'text-to-image'
  | 'image-to-image'
  | 'text-to-video'
  | 'image-to-video'
  | 'reference-to-video';
export type RunningHubInputKind = 'auto' | RunningHubConcreteInputKind;

const RUNNINGHUB_IMAGE_SUFFIXES = [
  RUNNINGHUB_INPUT_KIND_IMAGE_SUFFIX,
  RUNNINGHUB_INPUT_KIND_LEGACY_IMAGE_SUFFIX,
];

const RUNNINGHUB_KNOWN_SUBMIT_SUFFIXES = [
  RUNNINGHUB_INPUT_KIND_TEXT_SUFFIX,
  ...RUNNINGHUB_IMAGE_SUFFIXES,
  RUNNINGHUB_INPUT_KIND_TEXT_TO_VIDEO_SUFFIX,
  RUNNINGHUB_INPUT_KIND_IMAGE_TO_VIDEO_SUFFIX,
  RUNNINGHUB_INPUT_KIND_REFERENCE_TO_VIDEO_SUFFIX,
  RUNNINGHUB_INPUT_KIND_MULTIMODAL_VIDEO_SUFFIX,
];

function normalizePath(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

export function resolveRunningHubInputKind(rawInputKind: unknown, submitPath: string): RunningHubInputKind {
  const text = String(rawInputKind || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (text === 'auto') {
    return 'auto';
  }
  if (text === 'image-to-image' || text === 'img2img' || text === 'edit') {
    return 'image-to-image';
  }
  if (text === 'text-to-image' || text === 'txt2img') {
    return 'text-to-image';
  }
  if (text === 'image-to-video' || text === 'img2video' || text === 'i2v') {
    return 'image-to-video';
  }
  if (text === 'text-to-video' || text === 'txt2video' || text === 't2v') {
    return 'text-to-video';
  }
  if (text === 'reference-to-video' || text === 'ref2video' || text === 'r2v') {
    return 'reference-to-video';
  }

  const normalizedPath = normalizePath(submitPath);
  if (normalizedPath.endsWith(`/${RUNNINGHUB_INPUT_KIND_TEXT_SUFFIX}`)) {
    return 'text-to-image';
  }
  if (RUNNINGHUB_IMAGE_SUFFIXES.some((suffix) => normalizedPath.endsWith(`/${suffix}`))) {
    return 'image-to-image';
  }
  if (normalizedPath.endsWith(`/${RUNNINGHUB_INPUT_KIND_TEXT_TO_VIDEO_SUFFIX}`)) {
    return 'text-to-video';
  }
  if (normalizedPath.endsWith(`/${RUNNINGHUB_INPUT_KIND_IMAGE_TO_VIDEO_SUFFIX}`)) {
    return 'image-to-video';
  }
  if (normalizedPath.endsWith(`/${RUNNINGHUB_INPUT_KIND_REFERENCE_TO_VIDEO_SUFFIX}`)) {
    return 'reference-to-video';
  }
  if (normalizedPath.endsWith(`/${RUNNINGHUB_INPUT_KIND_MULTIMODAL_VIDEO_SUFFIX}`)) {
    return 'auto';
  }

  return 'auto';
}

export function isRunningHubKnownSubmitPath(path: string | null | undefined): boolean {
  const normalizedPath = normalizePath(path);
  return RUNNINGHUB_KNOWN_SUBMIT_SUFFIXES.some((suffix) => normalizedPath.endsWith(`/${suffix}`));
}

export function resolveRunningHubModelNameSuffix(value?: string | null): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/\/(?:edit|image-to-image|text-to-image|image-to-video|text-to-video|reference-to-video|multimodal-video)$/i, '');
}

export function resolveRunningHubSubmitActionSuffix(
  inputKind: RunningHubConcreteInputKind,
  modelRootPath?: string | null,
): string {
  const normalizedRoot = normalizePath(modelRootPath);
  if (
    normalizedRoot.startsWith('/openapi/v2/bytedance/')
    && (inputKind === 'text-to-video' || inputKind === 'image-to-video' || inputKind === 'reference-to-video')
  ) {
    return RUNNINGHUB_INPUT_KIND_MULTIMODAL_VIDEO_SUFFIX;
  }
  switch (inputKind) {
    case 'image-to-image':
      return RUNNINGHUB_INPUT_KIND_IMAGE_SUFFIX;
    case 'image-to-video':
      return RUNNINGHUB_INPUT_KIND_IMAGE_TO_VIDEO_SUFFIX;
    case 'text-to-video':
      return RUNNINGHUB_INPUT_KIND_TEXT_TO_VIDEO_SUFFIX;
    case 'reference-to-video':
      return RUNNINGHUB_INPUT_KIND_REFERENCE_TO_VIDEO_SUFFIX;
    case 'text-to-image':
    default:
      return RUNNINGHUB_INPUT_KIND_TEXT_SUFFIX;
  }
}
