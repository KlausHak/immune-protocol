import type { EndScreenResult } from '../core/ui';
import { CAMPAIGN } from '../campaign';
import type { GameContext } from './contracts';

export function buildEndResult(game: GameContext, winnerTeam: number | null, reason: string): EndScreenResult {
  const me = game.world.player(game.localPlayerId), foe = game.world.player(game.enemyPlayerId);
  const victory = winnerTeam != null && winnerTeam === me.team;
  const mission = game.mission?.info;
  const idx = mission ? CAMPAIGN.findIndex((m) => m.id === mission.id) : -1;
  return {
    victory,
    title: victory ? 'OUTBREAK CONTAINED' : 'CAMPUS LOST',
    subtitle: mission ? `${mission.subtitle}: ${mission.title}` : `Skirmish — ${reason}`,
    missionId: mission?.id,
    nextMissionId: victory && idx >= 0 ? CAMPAIGN[idx + 1]?.id ?? null : null,
    timeSeconds: game.world.time,
    stats: [
      { label: 'Units trained', you: me.stats.unitsTrained, enemy: foe.stats.unitsTrained },
      { label: 'Units lost', you: me.stats.unitsLost, enemy: foe.stats.unitsLost },
      { label: 'Enemies destroyed', you: me.stats.unitsKilled + me.stats.buildingsKilled, enemy: foe.stats.unitsKilled + foe.stats.buildingsKilled },
      { label: 'Structures built', you: me.stats.buildingsBuilt, enemy: foe.stats.buildingsBuilt },
      { label: 'Resources gathered', you: Math.round(me.stats.matterGathered), enemy: Math.round(foe.stats.matterGathered) },
      { label: 'Upgrades researched', you: me.stats.upgradesResearched, enemy: foe.stats.upgradesResearched },
    ],
  };
}
