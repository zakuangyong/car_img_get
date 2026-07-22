from __future__ import annotations

import torch


class Config:
    """Inference-only configuration matching the MainCar epoch_120 checkpoint."""

    def __init__(self) -> None:
        self.batch_size = 2
        self.SDPA_enabled = torch.cuda.is_available()

        self.ms_supervision = True
        self.out_ref = True
        self.dec_ipt = True
        self.dec_ipt_split = True
        self.cxt_num = 3
        self.mul_scl_ipt = "cat"
        self.dec_att = "ASPPDeformable"
        self.squeeze_block = "BasicDecBlk_x1"
        self.dec_blk = "BasicDecBlk"
        self.lat_blk = "BasicLatBlk"
        self.dec_channels_inter = "fixed"
        self.auxiliary_classification = False

        self.bb = "swin_v1_l"
        self.freeze_bb = True
        channels = [1536, 768, 384, 192]
        self.lateral_channels_in_collection = [channel * 2 for channel in channels]
        self.cxt = self.lateral_channels_in_collection[1:][::-1][-self.cxt_num :]

        # Kept for the shared backbone builder. Pretrained weights are disabled when
        # loading the project checkpoint, so no external files are read from here.
        self.weights: dict[str, str] = {}
