import {
  getModelBgColor,
  getModelRingColor,
  getModelHoverBgColor,
} from '$lib/utils/modelColors';
import { isAutoModel } from '$lib/utils/models';
import type { SdkImageContent } from '$lib/stores/sdkSessions';
import type { ImageData } from '$lib/utils/image';

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  is_main: boolean;
  is_detached: boolean;
}

export interface WorktreeCreationResult {
  worktree_path: string;
  branch: string;
}

export function toImageData(images: SdkImageContent[] | null | undefined): ImageData[] {
  if (!Array.isArray(images)) {
    return [];
  }

  return images.map((img) => ({
    mediaType: img.mediaType,
    base64Data: img.base64Data,
    width: img.width ?? 0,
    height: img.height ?? 0,
    originalSize: 0,
    compressedSize: 0,
  }));
}

export function toSdkImageContent(images: ImageData[]): SdkImageContent[] {
  return images.map((img) => ({
    mediaType: img.mediaType,
    base64Data: img.base64Data,
    width: img.width,
    height: img.height,
  }));
}

export function getModelButtonClasses(
  id: string,
  isSelected: boolean,
  isSmartModelEnabled: boolean
): string {
  const base = 'rounded font-medium transition-all px-3 py-1.5 text-xs';

  if (isAutoModel(id) && !isSmartModelEnabled) {
    return `${base} text-text-muted hover:text-text-secondary hover:bg-surface-elevated`;
  }

  if (isSelected) {
    if (isAutoModel(id)) {
      return `${base} bg-gradient-to-r from-purple-500 to-amber-500 text-white shadow-md ring-2 ring-purple-400 ring-opacity-50`;
    }
    return `${base} ${getModelBgColor(id)} text-white shadow-md ring-2 ${getModelRingColor(id)} ring-opacity-50`;
  }

  if (isAutoModel(id)) {
    return `${base} text-text-secondary hover:bg-gradient-to-r hover:from-purple-500/20 hover:to-amber-500/20`;
  }

  return `${base} text-text-secondary ${getModelHoverBgColor(id)}`;
}

export function getWorktreeLabel(wt: WorktreeInfo): string {
  const branch = wt.branch || '(detached)';
  const parts = wt.path.replace(/\\/g, '/').split('/');
  const relativePath = parts.slice(-2).join('/');
  return `${branch} (${relativePath})`;
}
