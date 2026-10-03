import type { UseFormReturn } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { applyServerErrors } from './form-errors';

type Values = { name: string; claimMap: string };

const fakeForm = (values: Values = { name: '', claimMap: '' }) => {
  const setError = vi.fn();
  const form = { getValues: () => values, setError } as unknown as UseFormReturn<Values>;
  return { form, setError };
};

const problem = (errors: { path: string; message: string }[], title = 'Invalid') =>
  new ApiError({ status: 422, title, errors });

describe('applyServerErrors', () => {
  it('puts an error on the field its path names, for a pointer or a plain name', () => {
    const { form, setError } = fakeForm();
    const rest = applyServerErrors(
      form,
      problem([
        { path: '/name', message: 'Taken' },
        { path: 'claimMap', message: 'Bad' },
      ]),
    );
    expect(rest).toBeUndefined();
    expect(setError).toHaveBeenCalledWith('name', { type: 'server', message: 'Taken' });
    expect(setError).toHaveBeenCalledWith('claimMap', { type: 'server', message: 'Bad' });
  });

  it('uses the first segment of a nested path: /claimMap/email goes to claimMap', () => {
    const { form, setError } = fakeForm();
    applyServerErrors(form, problem([{ path: '/claimMap/email', message: 'Unknown claim' }]));
    expect(setError).toHaveBeenCalledWith('claimMap', { type: 'server', message: 'Unknown claim' });
  });

  it('returns a form-level message for an error that names no field of the form', () => {
    const { form, setError } = fakeForm();
    const rest = applyServerErrors(form, problem([{ path: '/other', message: 'Nope' }]));
    expect(rest).toBe('/other: Nope');
    expect(setError).not.toHaveBeenCalled();
    expect(applyServerErrors(form, problem([{ path: '', message: 'Whole body' }]))).toBe(
      'Whole body',
    );
  });

  it('keeps the last unplaced message when several do not fit', () => {
    const { form } = fakeForm();
    expect(
      applyServerErrors(
        form,
        problem([
          { path: '/a', message: 'one' },
          { path: '/b', message: 'two' },
        ]),
      ),
    ).toBe('/b: two');
  });

  it('a problem without field errors becomes the message of the error', () => {
    const { form, setError } = fakeForm();
    expect(applyServerErrors(form, problem([], 'Conflict'))).toBe('Conflict');
    expect(setError).not.toHaveBeenCalled();
  });

  it('answers undefined for an error that is not an ApiError, so the caller keeps its own message', () => {
    const { form } = fakeForm();
    expect(applyServerErrors(form, new Error('boom'))).toBeUndefined();
    expect(applyServerErrors(form, 'text')).toBeUndefined();
  });

  it('lets the caller map paths to fields', () => {
    const { form, setError } = fakeForm();
    applyServerErrors(form, problem([{ path: '/params/points', message: 'Too many' }]), (path) =>
      path.startsWith('/params') ? 'name' : undefined,
    );
    expect(setError).toHaveBeenCalledWith('name', { type: 'server', message: 'Too many' });
  });
});
