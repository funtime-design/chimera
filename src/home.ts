import { buildHomePage } from "./rules";
import { deploymentDefaults } from "./deployment";

// The front page at /docs: what goonbridge can do and who is on it, for signed-in members.
// Names and online flags only: no tokens, emails, statuses or message contents.

export type HomeMember = { name: string; online: boolean };
export type HomePerson = HomeMember & { devices: HomeMember[] };

export type HomeData = {
  origin: string;
  version: string;
  deployed: string | null;
  tools: Array<{ name: string; description: string }>;
  people: HomePerson[];
  standalone: HomeMember[];
  claimSeconds: number;
  onlineSeconds: number;
  expirySeconds: number;
};

export const homePage = (d: HomeData): string => buildHomePage(deploymentDefaults, d);
