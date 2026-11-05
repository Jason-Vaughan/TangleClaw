'use strict';
/* ── TangleClaw v3 — Project Settings Visual Identity Controller (#2862, A503-R1) ── */
/* Slice 2 of #1573: wraps lib/terminal-identity.js's pure derivation        */
/* (deriveProjectIdentity) with the Project Settings form state a custom     */
/* background/logo/size/opacity/position control panel needs -- validation  */
/* per field, and a live preview recomputed from the current, possibly      */
/* invalid, form state. Mounting this inside the real Project Settings      */
/* panel (public/app.js) is Milestone #54 per Ruling A503-R1 point 3; this  */
/* file is the complete, testable controller that mount will instantiate    */
/* unchanged.                                                               */

(function (global) {
  /** Where a custom background logo may be anchored. */
  const LOGO_POSITIONS = Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']);

  /** The form fields a visual identity override may set, each optional -- an unset field falls back to the derived default. */
  const FIELD_NAMES = Object.freeze(['backgroundColor', 'logoUrl', 'logoSize', 'logoOpacity', 'logoPosition']);

  /**
   * A new, all-unset form state -- every field falls back to the project's
   * derived default until the operator sets one explicitly.
   * @returns {{backgroundColor: null, logoUrl: null, logoSize: number, logoOpacity: number, logoPosition: string}}
   */
  function emptyFormState() {
    return { backgroundColor: null, logoUrl: null, logoSize: 100, logoOpacity: 1, logoPosition: 'bottom-right' };
  }

  /**
   * Validate one field's candidate value in isolation, so a form can mark a
   * single invalid field red without discarding the rest of what the
   * operator already typed.
   * @param {string} field - One of {@link FIELD_NAMES}.
   * @param {*} value
   * @returns {{ok: true}|{ok: false, message: string}}
   */
  function validateField(field, value) {
    if (field === 'backgroundColor') {
      if (value === null || value === '') return { ok: true };
      return /^#[0-9a-fA-F]{6}$/.test(value) ? { ok: true } : { ok: false, message: 'backgroundColor must be a #rrggbb hex string.' };
    }
    if (field === 'logoUrl') {
      if (value === null || value === '') return { ok: true };
      return typeof value === 'string' ? { ok: true } : { ok: false, message: 'logoUrl must be a string.' };
    }
    if (field === 'logoSize') {
      return Number.isFinite(value) && value >= 10 && value <= 200
        ? { ok: true } : { ok: false, message: 'logoSize must be a number from 10 to 200 (percent).' };
    }
    if (field === 'logoOpacity') {
      return Number.isFinite(value) && value >= 0 && value <= 1
        ? { ok: true } : { ok: false, message: 'logoOpacity must be a number from 0 to 1.' };
    }
    if (field === 'logoPosition') {
      return LOGO_POSITIONS.includes(value) ? { ok: true } : { ok: false, message: `logoPosition must be one of ${LOGO_POSITIONS.join(', ')}.` };
    }
    return { ok: false, message: `"${field}" is not a recognized visual identity field.` };
  }

  /**
   * Validate an entire form state, field by field.
   * @param {object} formState
   * @returns {{ok: boolean, errors: Object<string, string>}} `errors` holds
   *   only the fields that failed, keyed by field name.
   */
  function validateForm(formState) {
    const errors = {};
    for (const field of FIELD_NAMES) {
      const v = validateField(field, formState ? formState[field] : undefined);
      if (!v.ok) errors[field] = v.message;
    }
    return { ok: Object.keys(errors).length === 0, errors };
  }

  /**
   * Create a Project Settings visual identity controller for one project.
   * Holds the in-progress form state (never persisted here -- Milestone
   * #54's mount owns reading/writing the project's stored overrides) and
   * recomputes the live preview on every change.
   * @param {object} options
   * @param {string} options.projectId
   * @param {string} [options.projectName]
   * @param {Function} options.deriveProjectIdentity - `lib/terminal-identity.js#deriveProjectIdentity`.
   * @param {object} [options.initial] - Initial form state; unset fields use {@link emptyFormState}.
   * @param {(preview: object) => void} [options.onChange] - Called with {@link getPreview}'s result after every `setField`.
   * @returns {object} The controller.
   */
  function createController(options) {
    const opts = options || {};
    if (typeof opts.projectId !== 'string' || !opts.projectId) {
      throw new Error('createController: options.projectId is required.');
    }
    const deriveProjectIdentity = opts.deriveProjectIdentity;
    if (typeof deriveProjectIdentity !== 'function') {
      throw new Error('createController: options.deriveProjectIdentity is required.');
    }
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

    let formState = Object.assign(emptyFormState(), opts.initial || {});

    function getFormState() {
      return Object.assign({}, formState);
    }

    /**
     * Set one field, validating it first. An invalid value is REJECTED
     * (the field keeps its prior value) rather than stored and flagged --
     * the live preview this controller computes must never be derived
     * from a value `deriveProjectIdentity` itself would refuse.
     * @param {string} field
     * @param {*} value
     * @returns {{ok: true}|{ok: false, message: string}}
     */
    function setField(field, value) {
      const v = validateField(field, value);
      if (!v.ok) return v;
      formState = Object.assign({}, formState, { [field]: value });
      onChange(getPreview());
      return { ok: true };
    }

    /**
     * The current form state's live preview: the project's derived
     * identity, with `backgroundColor`/`logoUrl` (when set) applied as
     * `deriveProjectIdentity`'s own override fields, plus the
     * logo-specific layout fields no lower layer knows about.
     * @returns {{ok: true, identity: object, logo: {url: (string|null), size: number, opacity: number, position: string}}
     *   |{ok: false, code: string, message: string}}
     */
    function getPreview() {
      const result = deriveProjectIdentity({
        projectId: opts.projectId,
        projectName: opts.projectName,
        overrideColor: formState.backgroundColor || undefined
      });
      if (result.ok === false) return result;
      return {
        ok: true,
        identity: result.identity,
        logo: { url: formState.logoUrl, size: formState.logoSize, opacity: formState.logoOpacity, position: formState.logoPosition }
      };
    }

    function reset() {
      formState = emptyFormState();
      onChange(getPreview());
    }

    return { getFormState, setField, getPreview, reset };
  }

  const controller = { LOGO_POSITIONS, FIELD_NAMES, emptyFormState, validateField, validateForm, createController };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = controller;
  }
  if (global) {
    global.tcTerminalIdentityUi = controller;
  }
})(typeof window !== 'undefined' ? window : null);
