import { badRequest } from './http.ts';

/** Reads ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive) into an ISO [from, to) range; default last 90 days. */
export function period(url: URL): { from: string; to: string; fromDate: string; toDate: string } {
	const today = new Date().toISOString().slice(0, 10);
	const fromDate = url.searchParams.get('from') || new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
	const toDate = url.searchParams.get('to') || today;
	const re = /^\d{4}-\d{2}-\d{2}$/;
	if (!re.test(fromDate) || !re.test(toDate)) throw badRequest('Dates must be YYYY-MM-DD');
	const from = new Date(`${fromDate}T00:00:00.000Z`).toISOString();
	const to = new Date(Date.parse(`${toDate}T00:00:00.000Z`) + 86_400_000).toISOString();
	if (from >= to) throw badRequest('The start date must be before the end date');
	return { from, to, fromDate, toDate };
}
