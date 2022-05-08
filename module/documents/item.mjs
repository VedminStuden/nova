const ItemData = foundry.data.ItemData;

class NovaItemData extends ItemData {

  static defineSchema() {
    let schema = super.defineSchema();
    schema.img.default = (data) => this.DEFAULT_ICON[data.type];
    return schema;
  }

  static DEFAULT_ICON = {
    power: 'icons/magic/symbols/symbol-lightning-bolt.webp',
    flare: 'icons/magic/symbols/cog-glowing-green.webp'
  }
}

/**
 * Extend the basic Item with some very simple modifications.
 * @extends {Item}
 */
export class NovaItem extends Item {

  static get schema() {
    return NovaItemData;
  }

  /**
   * Augment the basic Item data model with additional dynamic data.
   */
  prepareData() {
    // As with the actor class, items are documents that can have their data
    // preparation methods overridden (such as prepareBaseData()).
    super.prepareData();
  }

  /**
   * Prepare a data object which is passed to any Roll formulas which are created related to this Item
   * @private
   */
   getRollData() {
    let rollData = {};
    
    // If present, return the actor's roll data.
    if ( this.actor ) rollData = this.actor.getRollData();

    rollData.item = foundry.utils.deepClone(this.data.data);

    return rollData;
  }

  async getItemChatData({rollMode = game.settings.get('core', 'rollMode') } = {}) {
    const item = this.data;
    
    // Initialize chat data.
    const speaker = ChatMessage.getSpeaker({ token: this.actor.token ?? this.actor.getActiveTokens()[0].document, actor: this.actor });
    const label = `<img src="${item.img}" width="36" heigh="36"/><h3>${item.name}</h3>`;

    let description = item.data.description ?? '';
    let mods = [];
    let harm = []

    /* if attached to an actor, see if we can find any relevant mod info */
    if (this.actor) {
      if (this.type == 'power') {

        /* construct info about attached flare mods */
        switch (this.data.data.type) {
          case 'active':
            this.data.data.mods.forEach( modId => {
              const mod = this.actor.items.get(modId);
              if (mod) {
                mods.push({name: mod.data.name, img: mod.data.img, description: mod.data.data.description});
              }
            });
            break;
          case 'passive':
          case 'supernova':
            this.actor.data.data.mods.forEach( persistentMod => {
              const mod = this.actor.items.get(persistentMod);
              if (mod?.data.data.affects == this.data.data.type){
                mods.push({name: mod.data.name, img: mod.data.img, description: mod.data.data.description});
              }
            });
            break;
        }

        /* construct info about available Harm */
        harm = this.data.data.harm?.map( harm => harm.name ) ?? [];
      }
    }

    const html = await renderTemplate("systems/nova/templates/dice/item-roll.html", {mods, description, harm, uuid: this.uuid});
    

    return {speaker, rollMode, label, description: html}
  }

  async getHarmChatData(harmInfo, {rollMode = game.settings.get('core', 'rollMode')} = {}) {
    const item = this.data;
    let targets = [];
    game.user.targets.forEach( target => targets.push(target.actor.uuid) );
    const casters = [this.actor.uuid];

    // Initialize chat data.
    let speaker = ChatMessage.getSpeaker({ token: this.actor.token ?? this.actor.getActiveTokens()[0].document, actor: this.actor });

    speaker.alias += `: ${this.name} - ${harmInfo.name}`

    //const label = `<img src="${item.img}" width="36" height="36"/><strong>${this.name} - ${harmInfo.name}</strong>`;

    const footEntries = NovaItem.footerEntries(harmInfo);
    const harmFooter = footEntries.reduce( (acc, entry) => {
      return acc += `${acc.length == 0 ? '' : ' |'} ${entry}` 
    },"");

    let data = {harmInfo, casters, targets, itemUuid: this.uuid, harmFooter};
    data.resourceLabel = game.i18n.format("NOVA.SpendResource", {num: harmInfo.cost.value, resource: game.i18n.localize(CONFIG.NOVA.costResource[harmInfo.cost.source])});
    data.harmLabel = game.i18n.format("NOVA.ApplyHarm", {num: harmInfo.harm.value});

    const html = await renderTemplate("systems/nova/templates/chat/harm-roll.html", data);

    return {speaker, /*label,*/ description: html, rollMode};
  }

  /**
   * Handle rolling
   * @param 
   * @private
   */
  async roll({rollModeOverride, createMessage=true} = {}) {

    const {speaker, rollMode, label, description} = await this.getItemChatData({rollMode: rollModeOverride});

    //send chat message
    return ChatMessage.create({
      speaker: speaker,
      rollMode: rollMode,
      flavor: label,
      content: description
    });
  }

  getHarmInfo(identifier) {

    /* if handed a string, try to parse as a number */
    let index = parseInt(identifier);

    if(isNaN(index)) {
      ui.notifications.error('Could not locate harm by index');
      return false;
    }

    /* accounting for 1.0 -> 1.1 migration where harm was added
     * to items */
    const currentHarm = this.data.data.harm ?? [];

    if(index > currentHarm.length) {
      ui.notifications.error('Invalid harm index provided');
      return false;
    }

    const item = this;

    return {
      _spendRoll: null,
      _harmRoll: null,
      _harmSource: currentHarm,
      index,
      get harmArrayClone() {
        return deepClone(this._harmSource);
      },
      get harm() {
        return this._harmSource[this.index];
      },
      async evalHarm() {
        let harm = duplicate(this._harmSource[this.index]);

        if(!this._spendRoll || !this._harmRoll) {
          const rollData = item.getRollData();

          if (!this._spendRoll) {
            this._spendRoll = await new Roll(harm.cost.value, rollData).evaluate({async:true}); 
          } 

          if (!this._harmRoll) {
            this._harmRoll = await new Roll(harm.harm.value, rollData).evaluate({async:true});
          }
        }

        harm.cost.value = this._spendRoll.total;
        harm.harm.value = this._harmRoll.total; 

        return harm;
      }
    }
  }


  /** 
   * Handle adding new harm data
   */
  async addHarm(harmData = CONFIG.NOVA.DEFAULTS.HARM_DATA){

    /* accounting for 1.0 -> 1.1 migration where harm was added
     * to items */
    const currentHarm = this.data.data.harm ?? [];

    const updatedHarm = currentHarm.concat([harmData]); 
    await this.update({'data.harm': updatedHarm});
  }

  /**
   * Handle deleting harm data
   * @param {String|Number} name or index
   */
  async deleteHarm(identifier) {

    const harmInfo = this.getHarmInfo(identifier);
    if(!harmInfo) return false;

    let currentHarm = harmInfo.harmArrayClone;

    currentHarm.splice(harmInfo.index,1);
    await this.update({'data.harm': currentHarm})
  }

  async updateHarm(identifier, harmData) {

    const harmInfo = this.getHarmInfo(identifier);
    if(!harmInfo) return false;

    let currentHarm = harmInfo.harmArrayClone;

    mergeObject(currentHarm[harmInfo.index], harmData);
    await this.update({'data.harm': currentHarm})
  }

  async rollHarm(identifier, {createChatMessage = true, rollModeOverride} = {}) {
    const harmInfo = this.getHarmInfo(identifier);

    const {speaker, rollMode, /*label,*/ description} = await this.getHarmChatData( await harmInfo.evalHarm(), {rollMode: rollModeOverride});

    return ChatMessage.create({
      speaker,
      rollMode,
      //flavor: label,
      content: description
    }, {temporary: !createChatMessage});

  }

  async _applyUseChange(path, targets, change) {

    if(typeof targets == 'string') targets = [targets];

    const promises = targets.map( async (targetUuid) => {
      let target = await fromUuid(targetUuid);
      target = target instanceof TokenDocument ? target.actor : target;
      if (target.isOwner) {
        const original = getProperty(target.data, path);
        return target.update({[path]: original + change}, {change, source: game.i18n.localize(CONFIG.NOVA.costResource[path])});
      }

      return false;
    })

    return Promise.all(promises);
  }

  static _chatListeners(html) {
    html.on("click", ".harm-button button", this._onItemCardAction.bind(this));
    html.on("click", ".harm-apply button", this._onHarmButtonAction.bind(this));
    html.on("contextmenu", ".harm-apply button", this._onHarmButtonAction.bind(this));

  }

  static async _onItemCardAction(event) {

    event.preventDefault();
    const button = event.currentTarget;
    const harmId = button.dataset.harmIndex;
    const {itemUuid} = button.closest(".harm-button").dataset;

    const item = await fromUuid(itemUuid);

    return item.rollHarm(harmId);

  }

  static async _onHarmButtonAction(event) {

    event.preventDefault();

    /* we are intercepting a right click for "auto-damage" */
    event.stopPropagation();

    const button = event.currentTarget;
    const {itemUuid} = button.closest(".harm-apply").dataset;
    let {path, targets, change} = button.dataset;

    if (event.type == 'click') {
      /* apply change to selected */
      targets = canvas.tokens.controlled.map( token => token.actor.uuid );
    } else if (event.type == 'contextmenu') {
      /* apply change to predefined targets/source */
      targets = targets.split(',');
    } else {
      /* um...no clue */
      targets = []
    }
    
    const item = await fromUuid(itemUuid);

    change = Number(change);
    return item._applyUseChange(path, targets, -change);
  }

  static footerEntries(harmInfo) {
    let entries = [];
    if(harmInfo.target.type !== 'none'){
      /* add target info */
      entries.push(`${game.i18n.localize('NOVA.Target')}: ${harmInfo.target.value.length == 0 ? '' : harmInfo.target.value + ' '}${game.i18n.localize(CONFIG.NOVA.target[harmInfo.target.type])}`);
    }

    if(!!harmInfo.range.min || !!harmInfo.range.max) {
      let entry = game.i18n.localize('NOVA.Range') + ': '
      const min = game.i18n.localize(CONFIG.NOVA.range[harmInfo.range.min]) ?? '';
      const max = game.i18n.localize(CONFIG.NOVA.range[harmInfo.range.max]) ?? '';

      if( !!min && !!max ){
        entry += `${min} - ${max}`
      } else {
        entry += `${min}${max}`;
      }

      entries.push(entry);
    }

    return entries;
  }
  
}

