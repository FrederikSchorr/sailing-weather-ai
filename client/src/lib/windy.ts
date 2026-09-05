export type Section3WindyConfig = {
  overlay: "wind" | "waves";
  product: string;
  url: string;
};

export function buildSection3WindyConfig({
  model,
  lat,
  lon,
  zoom,
}: {
  model: string;
  lat: number;
  lon: number;
  zoom: number;
}): Section3WindyConfig {
  const latitude = lat.toFixed(3);
  const longitude = lon.toFixed(3);

  if (model === "iconEu") {
    return {
      overlay: "waves",
      product: "iconEu",
      url: `https://www.windy.com/${latitude}/${longitude}/iconEuWaves/waves?iconEu,waves,${latitude},${longitude},${zoom},i:pressure,p:favs`,
    };
  }

  return {
    overlay: "wind",
    product: model,
    url: `https://www.windy.com/${latitude}/${longitude}/${model}?${model},wind,${latitude},${longitude},${zoom},i:pressure,p:favs`,
  };
}