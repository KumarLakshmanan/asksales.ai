import { useCallback, useEffect, useRef } from 'react';
import { selectedBusinessProfileId } from '@/lib/business-profile';
import { gmailSignedInAccount } from '@/lib/gmail-oauth';

/** An accepted server mutation may finish after its originating page is gone.
 * Do not turn that completion into feedback or a refresh for another context. */
export function useEmailIntegrationMutation() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  return useCallback(() => {
    const actorId = gmailSignedInAccount();
    const businessProfileId = selectedBusinessProfileId();
    return () => mounted.current && actorId === gmailSignedInAccount()
      && businessProfileId === selectedBusinessProfileId();
  }, []);
}
