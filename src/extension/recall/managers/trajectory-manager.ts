import type { RecallTrajectory } from '../types';

export class TrajectoryManager {
  private trajectories = new Map<number, RecallTrajectory>();

  store(promptIndex: number, trajectory: RecallTrajectory): void {
    this.trajectories.set(promptIndex, trajectory);
  }

  get(promptIndex: number): RecallTrajectory | undefined {
    return this.trajectories.get(promptIndex);
  }

  getByNodeId(nodeId: string): RecallTrajectory[] {
    return [...this.trajectories.values()].filter(t => t.nodeId === nodeId);
  }

  load(trajectories: Map<number, RecallTrajectory>): void {
    this.trajectories = new Map(trajectories);
  }

  reset(): void {
    this.trajectories.clear();
  }
}
