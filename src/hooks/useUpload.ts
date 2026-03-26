/**
 * useUpload — Manages file upload flow with status tracking.
 */

import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { uploadFile as apiUploadFile, type UploadResult } from '@/lib/api-client';

export type UploadStatus = 'idle' | 'uploading' | 'complete' | 'error';

export function useUpload() {
  const queryClient = useQueryClient();
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [lastUpload, setLastUpload] = useState<UploadResult | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const uploadFile = useCallback(
    async (file: File, fileType: string, mappingSet?: string): Promise<UploadResult> => {
      setUploadStatus('uploading');
      setError(null);
      try {
        const result = await apiUploadFile(file, fileType, mappingSet);
        setLastUpload(result);
        setUploadStatus('complete');
        // Invalidate calculation status and dashboards after upload
        queryClient.invalidateQueries({ queryKey: ['calculation-status'] });
        queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        return result;
      } catch (err) {
        setError(err as Error);
        setUploadStatus('error');
        throw err;
      }
    },
    [queryClient],
  );

  const reset = useCallback(() => {
    setUploadStatus('idle');
    setLastUpload(null);
    setError(null);
  }, []);

  return { uploadFile, uploadStatus, lastUpload, error, reset };
}
