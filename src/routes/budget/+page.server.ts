import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import {
	buildGrid,
	setCell,
	copyMonth,
	monthKey,
	shiftMonth,
	seedFromTemplate,
	replaceFromTemplate,
	futureMonths,
	deleteFutureMonths,
	templateTotals,
	TEMPLATE_MONTH,
	isTemplate
} from '$lib/server/budget.ts';
import { parseFormula, FormulaError } from '$lib/budget/formula.ts';

const VALID_MONTH = /^\d{4}-\d{2}$/;
const isMonthKey = (m: string) => VALID_MONTH.test(m) || isTemplate(m);

export const load: PageServerLoad = async ({ url }) => {
	const requested = url.searchParams.get('month');
	const month = requested && isMonthKey(requested) ? requested : monthKey();

	// A month you have not touched inherits the master budget, which is what
	// makes it a template rather than a thing to copy by hand every month.
	const seeded = isTemplate(month) ? 0 : seedFromTemplate(month);

	return {
		grid: buildGrid(month),
		template: isTemplate(month),
		hasTemplate: templateTotals() !== null,
		// Browsing forward seeds each month it lands on, so offer the way back
		// whenever that has actually happened.
		futureMonths: futureMonths(),
		templateMonth: TEMPLATE_MONTH,
		seeded,
		prevMonth: isTemplate(month) ? null : shiftMonth(month, -1),
		nextMonth: isTemplate(month) ? null : shiftMonth(month, 1),
		isCurrent: month === monthKey()
	};
};

export const actions: Actions = {
	setCell: async ({ request }) => {
		const form = await request.formData();
		const month = String(form.get('month') ?? '');
		const categoryId = Number(form.get('categoryId'));
		const formula = String(form.get('formula') ?? '');

		if (!isMonthKey(month) || !Number.isInteger(categoryId)) {
			return fail(400, { message: 'Bad request' });
		}

		// Reject a malformed formula at the edge so the sheet never stores text
		// that will only fail later, on every render.
		try {
			parseFormula(formula);
		} catch (err) {
			return fail(422, {
				categoryId,
				message: err instanceof FormulaError ? err.message : 'That formula could not be read'
			});
		}

		setCell(month, categoryId, formula);
		return { ok: true };
	},

	copyForward: async ({ request }) => {
		const form = await request.formData();
		const month = String(form.get('month') ?? '');
		if (!VALID_MONTH.test(month)) return fail(400, { message: 'Bad request' });
		const copied = copyMonth(shiftMonth(month, -1), month);
		return { ok: true, copied };
	},

	applyTemplate: async ({ request }) => {
		const form = await request.formData();
		const month = String(form.get('month') ?? '');
		if (!VALID_MONTH.test(month)) return fail(400, { message: 'Bad request' });
		const applied = replaceFromTemplate(month);
		return { ok: true, applied };
	},

	clearFuture: async () => {
		const cleared = deleteFutureMonths();
		return { ok: true, cleared };
	}
};
