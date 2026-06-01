from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional
import time
import re

import requests


DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://www.autohome.com.cn/",
}


@dataclass(frozen=True)
class PicItem:
    seriesid: int
    specid: int
    categoryid: int
    typeid: int
    picid: int
    specname: str
    originalpic: str
    nowebppic: str
    smallpic: str
    tag: str
    pointname: str
    colorname: str


@dataclass(frozen=True)
class BrandItem:
    brandid: int
    name: str
    firstletter: str
    logo: str
    country: str
    countryid: int


@dataclass(frozen=True)
class SeriesItem:
    seriesid: int
    name: str
    brandid: int
    brandname: str
    factoryid: int
    factoryname: str


@dataclass(frozen=True)
class SpecItem:
    specid: int
    name: str
    year: Optional[int]

@dataclass(frozen=True)
class SeriesInfo:
    seriesid: int
    seriesname: str
    brandid: int
    brandname: str


class AutohomeClient:
    def __init__(
        self,
        session: Optional[requests.Session] = None,
        timeout_s: float = 20.0,
        max_retries: int = 3,
        sleep_s: float = 0.2,
        city_id: int = 440300,
    ) -> None:
        self.session = session or requests.Session()
        self.session.headers.update(DEFAULT_HEADERS)
        self.timeout_s = timeout_s
        self.max_retries = max_retries
        self.sleep_s = sleep_s
        self.city_id = city_id
        self._series_info_cache: Dict[int, SeriesInfo] = {}

    def _get_json(self, url: str, params: Dict[str, Any]) -> Dict[str, Any]:
        last_err: Optional[Exception] = None
        for i in range(self.max_retries):
            try:
                resp = self.session.get(url, params=params, timeout=self.timeout_s)
                resp.raise_for_status()
                data = resp.json()
                return data
            except Exception as e:
                last_err = e
                time.sleep(self.sleep_s * (2**i))
        assert last_err is not None
        raise last_err

    def get_spec_ids(self, series_id: int) -> List[int]:
        return sorted({s.specid for s in self.get_specs(series_id)})

    def get_specs(self, series_id: int) -> List[SpecItem]:
        url = "https://car.app.autohome.com.cn/carMiddle/getSpecListBySeriesId"
        params = {"seriesId": series_id, "appId": "pc", "cityId": self.city_id}
        data = self._get_json(url, params)

        result = data.get("result")
        if not isinstance(result, dict):
            return []

        brand_info = result.get("brandInfo") or {}
        series_info = result.get("seriesInfo") or {}
        try:
            self._series_info_cache[int(series_id)] = SeriesInfo(
                seriesid=int(series_id),
                seriesname=str(series_info.get("name") or ""),
                brandid=int(brand_info.get("brandId") or 0),
                brandname=str(brand_info.get("name") or ""),
            )
        except Exception:
            pass

        specs: Dict[int, SpecItem] = {}
        for group in (result.get("list") or []) + (result.get("otherList") or []):
            if not isinstance(group, dict):
                continue
            items = group.get("list") or []
            if not isinstance(items, list):
                continue
            for it in items:
                if not isinstance(it, dict):
                    continue
                sid = it.get("specId") or it.get("specid") or it.get("SpecId")
                name = str(it.get("name") or "")
                if sid is None:
                    continue
                try:
                    sid_i = int(sid)
                except Exception:
                    continue
                specs[sid_i] = SpecItem(specid=sid_i, name=name, year=_parse_year(name))

        return sorted(specs.values(), key=lambda s: s.specid)

    def get_series_info(self, series_id: int) -> Optional[SeriesInfo]:
        cached = self._series_info_cache.get(int(series_id))
        if cached is not None:
            return cached
        _ = self.get_specs(series_id)
        return self._series_info_cache.get(int(series_id))

    def iter_pic_list(
        self,
        *,
        series_id: int,
        spec_id: int,
        category_id: int,
        page_size: int = 80,
        is_inner: int = 0,
        plugin_version: str = "11.65.1",
        pm: int = 1,
    ) -> Iterable[PicItem]:
        url = "https://car.app.autohome.com.cn/carbase/pic/getPicList"
        page_index = 1
        while True:
            params = {
                "pluginversion": plugin_version,
                "pm": pm,
                "seriesid": series_id,
                "specid": spec_id,
                "categoryid": category_id,
                "isinner": is_inner,
                "pagesize": page_size,
                "pageindex": page_index,
            }
            data = self._get_json(url, params)
            if int(data.get("returncode", -1)) != 0:
                return
            result = data.get("result") or {}
            piclist = result.get("piclist") or []
            for p in piclist:
                yield PicItem(
                    seriesid=int(series_id),
                    specid=int(p.get("specid") or spec_id or 0),
                    categoryid=int(p.get("categoryid") or category_id),
                    typeid=int(p.get("typeid") or 0),
                    picid=int(p.get("id")),
                    specname=str(p.get("specname") or ""),
                    originalpic=_force_https(str(p.get("originalpic") or "")),
                    nowebppic=_force_https(str(p.get("nowebppic") or "")),
                    smallpic=_force_https(str(p.get("smallpic") or "")),
                    tag=str(p.get("tag") or ""),
                    pointname=str(p.get("pointname") or ""),
                    colorname=str(p.get("colorname") or ""),
                )

            pagecount = int(result.get("pagecount") or 0)
            if pagecount <= 0 or page_index >= pagecount:
                return
            page_index += 1
            time.sleep(self.sleep_s)

    def get_brands(self) -> List[BrandItem]:
        url = "https://www.autohome.com.cn/ashx/AjaxIndexCarFind.ashx"
        data = self._get_json(url, {"type": 1})
        if int(data.get("returncode", -1)) != 0:
            return []
        result = data.get("result") or {}
        items = result.get("branditems") or []

        brands: List[BrandItem] = []
        for b in items:
            try:
                brands.append(
                    BrandItem(
                        brandid=int(b.get("id")),
                        name=str(b.get("name") or ""),
                        firstletter=str(b.get("bfirstletter") or ""),
                        logo=str(b.get("logo") or ""),
                        country=str(b.get("country") or ""),
                        countryid=int(b.get("countryid") or 0),
                    )
                )
            except Exception:
                continue
        return brands

    def get_series_by_brand(self, brand_id: int) -> List[SeriesItem]:
        url = "https://www.autohome.com.cn/ashx/AjaxIndexCarFind.ashx"
        data = self._get_json(url, {"type": 3, "value": int(brand_id)})
        if int(data.get("returncode", -1)) != 0:
            return []
        result = data.get("result") or {}
        factories = result.get("factoryitems") or []

        series: List[SeriesItem] = []
        for f in factories:
            factory_id = int(f.get("id") or 0)
            factory_name = str(f.get("name") or "")
            seriesitems = f.get("seriesitems") or []
            for s in seriesitems:
                try:
                    series.append(
                        SeriesItem(
                            seriesid=int(s.get("id")),
                            name=str(s.get("name") or ""),
                            brandid=int(brand_id),
                            brandname=str(result.get("brandname") or ""),
                            factoryid=factory_id,
                            factoryname=factory_name,
                        )
                    )
                except Exception:
                    continue
        return series

    def get_all_series(self) -> List[SeriesItem]:
        all_series: Dict[int, SeriesItem] = {}
        for b in self.get_brands():
            try:
                for s in self.get_series_by_brand(b.brandid):
                    all_series[s.seriesid] = s
            except Exception:
                continue
            time.sleep(self.sleep_s)
        return sorted(all_series.values(), key=lambda x: x.seriesid)


def _force_https(url: str) -> str:
    if url.startswith("http://"):
        return "https://" + url[len("http://") :]
    return url


def _parse_year(name: str) -> Optional[int]:
    m = re.search(r"(\d{4})\s*款", name)
    if not m:
        m = re.search(r"\b(19\d{2}|20\d{2})\b", name)
    if not m:
        return None
    try:
        return int(m.group(1))
    except Exception:
        return None

