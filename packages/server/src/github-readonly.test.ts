import {agentStormService} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';

describe('GitHub API contract', () => {
    it('exposes PR reads without GitHub write endpoints', () => {
        assert.deepEquals(
            Object.keys(agentStormService.endpoints).filter((path) => path.startsWith('/github/')),
            [
                '/github/pr',
                '/github/review-requested',
            ],
        );
    });
});
