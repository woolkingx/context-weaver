import { JsonProjector } from '../projection/json-projector.mjs';

export class OutputClass {
  constructor({
    format = 'json', stdout, humanSerializer, feedback = '',
  } = {}) {
    if (!stdout || typeof stdout.write !== 'function') {
      throw new TypeError('OutputClass requires a writable stdout port.');
    }
    this.format = format;
    this.stdout = stdout;
    this.humanSerializer = humanSerializer;
    this.feedback = feedback;
  }

  emit(value, { format = this.format, maxChars } = {}) {
    if (format === 'json' && maxChars === undefined) return `${JSON.stringify(value)}\n`;
    if (format === 'json') return JsonProjector.project({ value, maxChars });
    if (typeof this.humanSerializer !== 'function') {
      throw new TypeError('OutputClass requires a human serializer.');
    }
    return this.humanSerializer(value);
  }

  async write(serialized) {
    const output = String(serialized ?? '');
    const hasFeedback = output.includes(this.feedback);
    const withFeedback = this.format === 'json' || hasFeedback || !this.feedback
      ? output
      : `${output.trimEnd()}\n\n${this.feedback}\n`;
    await new Promise((resolve, reject) => {
      this.stdout.write(withFeedback, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}
