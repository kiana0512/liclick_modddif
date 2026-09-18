import { useToastStore } from '@/stores/toastStore';

// USER-FILE-UPLOAD/1.0.0: per original user-selected file, not generated assets.
export const MAX_USER_FILE_BYTES = 100 * 1024 * 1024;
export const USER_FILE_SIZE_ERROR = '文件大小超过 100MB 限制';

export function getUserFileUploadError(files: Iterable<Pick<File, 'size'>>) {
  for (const file of files) {
    if (file.size > MAX_USER_FILE_BYTES) return USER_FILE_SIZE_ERROR;
  }
  return undefined;
}

/** Reject the whole selection before reading, decoding or changing project state. */
export function allowUserFileUpload(files: Iterable<Pick<File, 'size'>>) {
  const error = getUserFileUploadError(files);
  if (!error) return true;
  useToastStore.getState().pushToast({ tone: 'error', title: '无法上传', description: error });
  return false;
}
