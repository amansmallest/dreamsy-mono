import type { Game } from "@/lib/content";

export function GameCard({ game }: { game: Game }) {
  return (
    <article className="game">
      <div className="game-shot">
        <img src={`/games/${game.id}.jpg`} alt={`${game.name} running on the Dreamsy engine`} loading="lazy" />
      </div>
      <div className="game-body">
        <h3>{game.name}</h3>
        <p>{game.blurb}</p>
        <div className="game-tags">
          {game.tags.map((t) => (
            <span key={t}>{t}</span>
          ))}
          <span className="view">{game.view}</span>
        </div>
      </div>
    </article>
  );
}
