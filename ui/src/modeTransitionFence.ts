export type ModeTransitionFence = {
  begin: () => number;
  isCurrent: (generation: number) => boolean;
};

export function createModeTransitionFence(): ModeTransitionFence {
  let currentGeneration = 0;
  return {
    begin() {
      currentGeneration += 1;
      return currentGeneration;
    },
    isCurrent(generation) {
      return generation === currentGeneration;
    },
  };
}
