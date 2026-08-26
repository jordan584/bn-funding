import type { GoogleChatMessage } from '../domain.js';
import type { PublishedFundingImages } from '../github/image-publisher.js';

function imageCard(cardId: string, title: string, imageUrl: string): GoogleChatMessage['cardsV2'][number] {
  return {
    cardId,
    card: {
      header: { title },
      sections: [{
        widgets: [
          {
            image: {
              imageUrl,
              altText: `${title}，点击打开高清原图`,
              onClick: { openLink: { url: imageUrl } }
            }
          },
          {
            buttonList: {
              buttons: [{
                text: '查看高清原图',
                altText: `在浏览器中打开 ${title} 高清原图`,
                onClick: { openLink: { url: imageUrl } }
              }]
            }
          }
        ]
      }]
    }
  };
}

export function buildFundingImageChatMessage(
  asOf: number,
  images: PublishedFundingImages
): GoogleChatMessage {
  return {
    text: `五交易所股票 Funding Top20（截至 ${asOf}）`,
    cardsV2: [
      imageCard('funding-image-1-10', '五交易所股票 Funding Top20 · #1–10', images.first),
      imageCard('funding-image-11-20', '五交易所股票 Funding Top20 · #11–20', images.second)
    ]
  };
}
