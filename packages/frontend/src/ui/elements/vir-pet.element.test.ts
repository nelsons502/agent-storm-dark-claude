import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {VirPet} from './vir-pet.element.js';

describe(VirPet.tagName, () => {
    it('anchors the pet to the bottom-left corner', () => {
        assert.isTrue(VirPet.styles.cssText.includes('left: 18px;'));
        assert.isFalse(VirPet.styles.cssText.includes('right: 18px;'));
    });
});
