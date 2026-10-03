import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { applyServerErrorsToList } from './guard-errors';

const problem = (errors: { path: string; message: string }[], title = 'Invalid') =>
  new ApiError({ status: 422, title, errors });

describe('applyServerErrorsToList (13.4)', () => {
  it('files an error under its guard and the input it names', () => {
    expect(
      applyServerErrorsToList(
        problem([
          { path: '/jev/model', message: 'Unknown model' },
          { path: '/llmJudge/apiKeySecret', message: 'Not found' },
          { path: '/classifier/url', message: 'Not a URL' },
        ]),
      ),
    ).toEqual({
      jev: { model: 'Unknown model' },
      llmJudge: { secret: 'Not found' },
      classifier: { endpoint: 'Not a URL' },
    });
  });

  it('shows what no input of the card names on the card itself', () => {
    expect(
      applyServerErrorsToList(
        problem([
          { path: '/jev', message: 'JEV needs an endpoint' },
          { path: '/jev/unheard', message: 'Unknown field' },
        ]),
      ),
    ).toEqual({ jev: { _: 'Unknown field' } });
    expect(
      applyServerErrorsToList(problem([{ path: '/jev', message: 'JEV needs an endpoint' }])),
    ).toEqual({
      jev: { _: 'JEV needs an endpoint' },
    });
  });

  it('ignores errors about anything that is not a guard, and falls back to the message', () => {
    const rest = applyServerErrorsToList(problem([{ path: '/other/x', message: 'No' }], 'Invalid'));
    expect(rest).toEqual({ jev: { _: 'Invalid' } });
  });

  it('answers nothing for an error that is not an ApiError', () => {
    expect(applyServerErrorsToList(new Error('boom'))).toEqual({});
    expect(applyServerErrorsToList(undefined)).toEqual({});
  });
});
