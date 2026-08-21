import { useEffect, useState } from 'react';

const SESSION_STORAGE_KEY = 'llm_debug_session_id';

function generateSessionId(): string {
  return crypto.randomUUID();
}

export function useSession() {
  const [sessionId, setSessionId] = useState<string>('');

  useEffect(() => {
    // Check URL for session_id param first
    const params = new URLSearchParams(window.location.search);
    const urlSessionId = params.get('session');

    if (urlSessionId) {
      setSessionId(urlSessionId);
      localStorage.setItem(SESSION_STORAGE_KEY, urlSessionId);
      return;
    }

    // Check localStorage
    let storedSessionId = localStorage.getItem(SESSION_STORAGE_KEY);

    if (!storedSessionId) {
      storedSessionId = generateSessionId();
      localStorage.setItem(SESSION_STORAGE_KEY, storedSessionId);
    }

    setSessionId(storedSessionId);
  }, []);

  const resetSession = () => {
    const newSessionId = generateSessionId();
    localStorage.setItem(SESSION_STORAGE_KEY, newSessionId);
    setSessionId(newSessionId);
    return newSessionId;
  };

  const getShareableUrl = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('session', sessionId);
    return url.toString();
  };

  return {
    sessionId,
    resetSession,
    getShareableUrl,
  };
}
