import { produce as produceRules, inputManifest as rulesInput } from './rules.mjs';
import { produce as produceSkills, inputManifest as skillsInput } from './skills.mjs';
import { produce as produceHandbook, inputManifest as handbookInput } from '../data-service/producers/handbook-producer.mjs';
import { CODEBASE_OWNER_DEFINITION } from '../db/loaders/codebase-loader.mjs';

export const PERSISTENT_OWNER_DEFINITIONS = new Map([
  ['rules', {
    name: 'rules',
    producerGeneration: 'rules-file-v1',
    async admit(root, options) {
      return { manifest: await rulesInput(root, 'rules-file-v1'), ...options };
    },
    async build({ root }) {
      return produceRules(root);
    },
  }],
  ['skills', {
    name: 'skills',
    producerGeneration: 'skills-file-v1',
    async admit(root, options) {
      return { manifest: await skillsInput(root, 'skills-file-v1'), ...options };
    },
    async build({ root }) {
      return produceSkills(root);
    },
  }],
  ['handbook', {
    name: 'handbook',
    producerGeneration: 'handbook-file-v2',
    async admit(root, options) {
      return { manifest: await handbookInput(root, 'handbook-file-v2'), ...options };
    },
    async build({ root }) {
      return produceHandbook(root);
    },
  }],
  ['codebase', CODEBASE_OWNER_DEFINITION],
]);
