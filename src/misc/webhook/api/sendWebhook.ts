import fetch from 'node-fetch';
import {Response} from 'node-fetch';

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const REQUEST_TIMEOUT = 10000; // 10 seconds

const isRetryableError = (error: any): boolean => {
  const errorMessage = error?.message?.toLowerCase() || '';
  const errorCode = error?.code?.toLowerCase() || '';
  
  return (
    errorMessage.includes('socket hang up') ||
    errorMessage.includes('econnreset') ||
    errorMessage.includes('etimedout') ||
    errorMessage.includes('timeout') ||
    errorCode === 'econnreset' ||
    errorCode === 'etimedout' ||
    errorCode === 'econnrefused'
  );
};

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

const sendWebhook = async (
  hookURL: string,
  payload: any,
  retryCount: number = 0,
): Promise<Response> => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const response = await fetch(hookURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response;
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      throw fetchError;
    }
  } catch (error: any) {
    // Check if it's a retryable error and we haven't exceeded max retries
    if (isRetryableError(error) && retryCount < MAX_RETRIES) {
      const delayMs = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
      
      await delay(delayMs);
      
      return sendWebhook(hookURL, payload, retryCount + 1);
    }

    // If not retryable or max retries exceeded, reject
    throw error;
  }
};

export default sendWebhook;
