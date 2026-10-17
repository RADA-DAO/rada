/** A process-wide bound on uploads being read, decoded or stored concurrently. */
export function processingBudget(maximum = 4) {
  let active = 0;
  return {
    acquire(): (() => void) | null {
      if (active >= maximum) return null;
      active++;
      let released = false;
      return () => {
        if (!released) active--;
        released = true;
      };
    },
  };
}
