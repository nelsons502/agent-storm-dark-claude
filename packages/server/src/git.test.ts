import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {hasActiveChangesRequested} from './git.js';

describe(hasActiveChangesRequested.name, () => {
    it('flags a reviewer who currently requests changes', () => {
        const result = hasActiveChangesRequested(
            [{state: 'CHANGES_REQUESTED', author: {login: 'alice'}}],
            new Set(),
        );
        assert.isTrue(result);
    });

    it('does not flag a reviewer who requested changes but was since re-requested', () => {
        const result = hasActiveChangesRequested(
            [{state: 'CHANGES_REQUESTED', author: {login: 'alice'}}],
            new Set(['alice']),
        );
        assert.isFalse(result);
    });

    it('does not flag an approving reviewer', () => {
        const result = hasActiveChangesRequested(
            [{state: 'APPROVED', author: {login: 'alice'}}],
            new Set(),
        );
        assert.isFalse(result);
    });

    it('still flags when one reviewer blocks and another was re-requested', () => {
        const result = hasActiveChangesRequested(
            [
                {state: 'CHANGES_REQUESTED', author: {login: 'alice'}},
                {state: 'CHANGES_REQUESTED', author: {login: 'bob'}},
            ],
            new Set(['bob']),
        );
        assert.isTrue(result);
    });

    it('is false when there are no reviews', () => {
        assert.isFalse(hasActiveChangesRequested([], new Set()));
    });
});
