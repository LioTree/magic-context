export interface ParityProfile {
	injection: boolean;
	skip: boolean;
	memory: boolean;
	temporal: boolean;
	caveman: boolean;
	language?: string;
	dreamer: boolean;
	smartNotes: boolean;
	compaction: boolean;
	preset: "full" | "light";
	override: boolean;
}
export interface ParityTurn {
	project: number;
	base: string;
	date: string;
	model: { provider: string; id: string };
	refresh: boolean;
	expired: boolean;
	overrideVersion: number;
	reuseSections: boolean;
}
export interface ParitySequence {
	seed: number;
	profiles: ParityProfile[];
	turns: ParityTurn[];
}

/** Fixed seeds make every generated multi-turn input reproducible on its own. */
export function standaloneParitySequences(count = 320): ParitySequence[] {
	return Array.from({ length: count }, (_, sequence) => {
		const seed = (0x3debe36 + sequence * 0x9e3779b9) >>> 0;
		let state = seed;
		const next = () => {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return (state >>> 0) / 0x1_0000_0000;
		};
		const bit = () => next() < 0.5;
		const profiles = Array.from(
			{ length: 3 },
			(_, project): ParityProfile => ({
				injection: project === 0 ? sequence % 7 !== 0 : bit(),
				skip: bit(),
				memory: bit(),
				temporal: bit(),
				caveman: bit(),
				language: [undefined, "en", "tr", "ja"][Math.floor(next() * 4)],
				dreamer: bit(),
				smartNotes: bit(),
				compaction: bit(),
				preset: bit() ? "full" : "light",
				override: bit(),
			}),
		);
		// User-only fields are shared by the projects in one extension registration.
		for (const profile of profiles) {
			profile.language = profiles[0].language;
			profile.smartNotes = profiles[0].smartNotes;
			profile.compaction = profiles[0].compaction;
			profile.override = profiles[0].override;
		}
		const turns = Array.from({ length: 12 }, (_, turn): ParityTurn => {
			const date = `2026-10-${12 + Math.floor(turn / 2)}`;
			const ordinary = `Project partner λ.\nToday's date: ${date} (UTC)\n<plugin-env>\nDate: ${date}\n</plugin-env>\n<document>\nDate: 1999-12-31\n</document>`;
			return {
				project: turn < 3 ? 0 : Math.floor(next() * 3),
				base:
					turn === 4
						? `## Magic Context\nExisting guidance.\n${ordinary}`
						: turn === 5
							? `PARITY_SKIP\n${ordinary}`
							: turn === 7
								? ""
								: ordinary,
				date,
				model: {
					provider: turn > 7 && bit() ? "openai" : "fixture",
					id: turn < 3 ? "a" : bit() ? "a" : "b",
				},
				refresh: turn > 2 && next() < 0.3,
				expired: turn > 2 && next() < 0.25,
				overrideVersion: Math.floor(turn / 3),
				reuseSections: turn === 2 || next() < 0.15,
			};
		});
		return { seed, profiles, turns };
	});
}
