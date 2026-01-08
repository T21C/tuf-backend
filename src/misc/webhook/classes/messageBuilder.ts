import {formatColor} from '../utils/index.js';

export default class MessageBuilder {
  private payload: {
    embeds: Array<{
      fields: Array<any>;
      [key: string]: any;
    }>;
    [key: string]: any;
  };

  constructor() {
    this.payload = {
      embeds: [],
    };
    this.addEmbed();
  }

  addEmbed() {
    this.payload.embeds.push({fields: []});
    return this;
  }

  getJSON() {
    return this.payload;
  }

  setText(text: string) {
    this.payload.content = text;

    return this;
  }

  setAuthor(author: string, authorImage: string, authorUrl: string) {
    this.payload.embeds[0].author = {};
    this.payload.embeds[0].author.name = author;
    this.payload.embeds[0].author.url = authorUrl;
    this.payload.embeds[0].author.icon_url = authorImage;

    return this;
  }

  setTitle(title: string, index = 0) {
    this.payload.embeds[index].title = title;

    return this;
  }

  setURL(url: string) {
    this.payload.embeds[0].url = url;

    return this;
  }

  setThumbnail(thumbnail: string) {
    this.payload.embeds[0].thumbnail = {};
    this.payload.embeds[0].thumbnail.url = thumbnail;

    return this;
  }

  setImage(image: string) {
    this.payload.embeds[0].image = {};
    this.payload.embeds[0].image.url = image;

    return this;
  }

  setTimestamp(date?: string) {
    if (date) {
      this.payload.embeds[0].timestamp = date;
    } else {
      this.payload.embeds[0].timestamp = new Date();
    }

    return this;
  }

  setColor(color: string | number) {
    this.payload.embeds[0].color = formatColor(color);

    return this;
  }

  setDescription(description: string, index = 0) {
    this.payload.embeds[index].description = description;

    return this;
  }

  addField(fieldName: string, fieldValue: string, inline: boolean, index = 0) {
    this.payload.embeds[index].fields.push({
      name: fieldName,
      value: fieldValue,
      inline: inline,
    });

    return this;
  }

  setFooter(footer: string, footerImage: string) {
    this.payload.embeds[0].footer = {};
    this.payload.embeds[0].footer.icon_url = footerImage;
    this.payload.embeds[0].footer.text = footer;

    return this;
  }

  static combine(...builders: MessageBuilder[]): MessageBuilder {
    const combined = new MessageBuilder();
    combined.payload.embeds = []; // Clear default embed

    // Combine all content fields with spaces between them
    const contents = builders
      .map(builder => builder.payload.content)
      .filter(content => content !== undefined);
    if (contents.length > 0) {
      combined.payload.content = contents.join(' ');
    }

    // Combine embeds
    for (const builder of builders) {
      combined.payload.embeds.push(...builder.payload.embeds);
    }

    return combined;
  }
}
