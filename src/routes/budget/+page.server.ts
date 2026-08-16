import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { buildGrid, setCell, copyMonth, monthKey, shiftMonth } from '$lib/server/budget.ts';
import { parseFormula, FormulaError } from '$lib/budget/formula.ts';

const VALID_MONTH = /^\d{4}-\d{2}$/;

export const load: PageServerLoad = async ({ url }) => {
	const requested = url.searchParams.get('month');
	const month = requested && VALID_MONTH.test(requested) ? requested : monthKey();
	return {
		grid: buildGrid(month),
		prevMonth: shiftMonth(month, -1),
		nextMonth: shiftMonth(month, 1),
		isCurrent: month === monthKey()
	};
};

export const actions: Actions = {
	setCell: async ({ request }) => {
		const form = await request.formData();
		const month = String(form.get('month') ?? '');
		const categoryId = Number(form.get('categoryId'));
		const formula = String(form.get('formula') ?? '');

		if (!VALID_MONTH.test(month) || !Number.isInteger(categoryId)) {
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
	}
};
